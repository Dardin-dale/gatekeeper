import { createHash } from "crypto";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, CustomResource, Duration, Stack, StackProps, Tags } from "aws-cdk-lib";
import { Provider } from "aws-cdk-lib/custom-resources";
import {
    BlockDeviceVolume,
    CfnVolume,
    CfnVolumeAttachment,
    EbsDeviceVolumeType,
    Instance,
    InstanceClass,
    InstanceSize,
    InstanceType,
    IpAddresses,
    MachineImage,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    UserData,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {
    Effect,
    ManagedPolicy,
    PolicyStatement,
    Role,
    ServicePrincipal
} from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { CfnScheduleGroup } from "aws-cdk-lib/aws-scheduler";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { Construct } from "constructs";
import * as path from "path";
import * as fs from "fs";
import { ACTIVE_GAME, DEFAULT_GAME, runtimeProfile, gameDomain } from "../games";
import { parseWorldConfigsFromJson, getDefaultWorldConfig } from "../lambdas/utils/world-config";
import {
    RestApi,
    LambdaIntegration,
    EndpointType
} from "aws-cdk-lib/aws-apigateway";
import {
    RetentionDays,
    LogGroup
} from "aws-cdk-lib/aws-logs";

// The AMI the instance boots. PINNED (see machineImage below for why) and hoisted
// here so it feeds the replacement fingerprint.
// Refresh: aws ssm get-parameter --name \
//   /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
//   --query Parameter.Value --output text
const AMI_ID = 'ami-0d45a4eba03d1e2cf'; // al2023-ami-2023.12.20260611.0-kernel-6.1-x86_64

/**
 * Identifies THIS instance configuration. It drives two things that must move
 * together: the VolumeDetachResource (which only runs when its property changes)
 * and the instance's DeploymentVersion tag. If they drift, CFN tries to attach a
 * still-attached data volume and the deploy rolls back on "volume already
 * attached".
 *
 * DERIVED, not hand-maintained. It used to be a literal that every AMI /
 * instance-type / user-data change had to remember to bump — a rule enforced only
 * by a comment, where forgetting produces a confusing rollback rather than a
 * clear error. Hashing the three inputs that actually cause a replacement makes
 * that impossible to get wrong in either direction: change one and the version
 * moves automatically; change none and it stays put, so unrelated deploys never
 * churn the instance.
 *
 * Inputs must be the COMPLETE set of replacement triggers — call this only after
 * user-data is fully built.
 */
function replacementFingerprint(amiId: string, instanceType: string, userData: string): string {
    const digest = createHash('sha256')
        .update([amiId, instanceType, userData].join('\u0000'))
        .digest('hex')
        .slice(0, 12);
    return `${instanceType}-${digest}`;
}

interface WorldConfig {
    /**
     * Display name of the world
     */
    name: string;

    /**
     * Discord server ID this world belongs to
     */
    discordServerId: string;

    /**
     * World name
     */
    worldName: string;

    /**
     * Server password for this world
     */
    serverPassword: string;
    
    /**
     * Discord webhook URL for notifications
     * This can be fetched from SSM parameter store
     */
    discordWebhook?: string;
}

interface GameServerStackProps extends StackProps {
    /**
     * Server password
     * From the active world config
     */
    serverPassword?: string;
    /**
     * Server display name
     * 
     */
    serverName?: string;
    /**
     * World name
     * 
     */
    worldName?: string;
    /**
     * Admin Steam IDs (space separated)
     */
    adminIds?: string;
    /**
     * Instance type to use
     * Default: t3.medium
     */
    instanceType?: InstanceType;
    /**
     * Size of data volume in GB
     * Default: 12
     */
    dataVolumeSize?: number;  // Default: 12
    /**
     * How often to run backups (in hours)
     * Default: 24 (once per day)
     */
    backupFrequencyHours?: number;
    /**
     * How many backups to keep
     * Default: 7
     */
    backupsToKeep?: number;
    /**
     * Configuration for multiple worlds
     * Each world gets its own backup folder in S3
     */
    worldConfigurations?: WorldConfig[];
    /**
     * Path to BepInEx mods directory
     * Mods will be copied to the server's BepInEx plugins directory
     * Default: "./mods"
     */
    modsDirectory?: string;
    /**
     * Whether to enable BepInEx for mod support
     * Default: true
     */
    enableBepInEx?: boolean;
}

export class GameServerStack extends Stack {
    public readonly ec2Instance: Instance;
    public readonly vpc: Vpc;
    public readonly backupBucket: Bucket;
    public readonly backupSchedule?: string;
    public readonly apiUrl: string;

    constructor(scope: Construct, id: string, props?: GameServerStackProps) {
        super(scope, id, props);
        
        // Load environment variables from .env (optional — fresh clones and CI
        // synth/test without one; already-set env vars take precedence).
        try {
            process.loadEnvFile();
        } catch {
            // no .env present — fine
        }

        // Instance size + data volume come from the active game profile (INSTANCE_TYPE overrides).
        // The world's name/password/save are resolved at runtime from SSM (written by
        // /gate start), not baked into the stack.
        const instanceType = props?.instanceType || new InstanceType(process.env.INSTANCE_TYPE || ACTIVE_GAME.instanceType);
        const dataVolumeSize = props?.dataVolumeSize || ACTIVE_GAME.dataVolumeSizeGb;
        const backupFrequencyHours = props?.backupFrequencyHours || 24;
        const backupsToKeep = props?.backupsToKeep || parseInt(process.env.BACKUPS_TO_KEEP || '7', 10);
        // Note: Auto-shutdown is controlled by SSM parameter /gatekeeper/<game>/auto-shutdown-minutes (default: 15 minutes)

        // Create VPC with a single public subnet
        this.vpc = new Vpc(this, "GameVpc", {
            ipAddresses: IpAddresses.cidr("10.0.0.0/24"),
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: "PublicSubnet",
                    subnetType: SubnetType.PUBLIC,
                },
            ],
            maxAzs: 1,
            enableDnsSupport: true,
            enableDnsHostnames: true,
        });

        // Security group for the EC2 instance
        const securityGroup = new SecurityGroup(this, "SecurityGroup", {
            vpc: this.vpc,
            description: "Security group for the game server",
            allowAllOutbound: true,
        });

        // Open the active game's ports (from its GameProfile) plus the Steam query port.
        for (const range of ACTIVE_GAME.ports) {
            const single = range.from === range.to;
            const portObj = range.protocol === "udp"
                ? (single ? Port.udp(range.from) : Port.udpRange(range.from, range.to))
                : (single ? Port.tcp(range.from) : Port.tcpRange(range.from, range.to));
            securityGroup.addIngressRule(
                Peer.anyIpv4(),
                portObj,
                `${ACTIVE_GAME.displayName} ${range.protocol.toUpperCase()} ${range.from}-${range.to}`,
            );
        }
        if (ACTIVE_GAME.queryPort) {
            securityGroup.addIngressRule(
                Peer.anyIpv4(),
                Port.udp(ACTIVE_GAME.queryPort),
                `${ACTIVE_GAME.displayName} Steam query (UDP)`,
            );
        }

        // Create S3 bucket for backups
        this.backupBucket = new Bucket(this, "BackupBucket", {
            versioned: true,
            removalPolicy: this.removalPolicy,
        });

        // Deploy scripts to S3 bucket for EC2 instance to download. The active
        // game's runtime profile is emitted alongside them as game-profile.json —
        // the single bridge from the TypeScript GameProfile to the host bash
        // runtime (read with jq by start-server.sh). One source of truth, no
        // hardcoded image/ports/env in the scripts.
        new BucketDeployment(this, "ScriptDeployment", {
            sources: [
                Source.asset("./scripts"),
                Source.jsonData("game/game-profile.json", runtimeProfile()),
            ],
            destinationBucket: this.backupBucket,
            destinationKeyPrefix: "scripts/",
        });

        // Deploy systemd service files to S3 for EC2 instance to download
        new BucketDeployment(this, "ServiceDeployment", {
            sources: [Source.asset("./services")],
            destinationBucket: this.backupBucket,
            destinationKeyPrefix: "services/",
        });

        // Create IAM role for EC2 instance
        const instanceRole = new Role(this, "InstanceRole", {
            assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"), // For SSM access
            ],
        });

        // Add policy for S3 access (for backups)
        instanceRole.addToPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
                resources: [
                    this.backupBucket.bucketArn,
                    `${this.backupBucket.bucketArn}/*`,
                ],
            })
        );

        // Add policy for EventBridge events
        instanceRole.addToPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["events:PutEvents"],
                resources: [
                    `arn:aws:events:${this.region}:${this.account}:event-bus/default`
                ],
            })
        );
        
        // Add policy for SSM Parameter Store access (for Discord webhooks and monitoring)
        instanceRole.addToPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    "ssm:GetParameter", 
                    "ssm:GetParameters",
                    "ssm:PutParameter"  // For monitoring scripts to store join codes
                ],
                resources: [
                    `arn:aws:ssm:${this.region}:${this.account}:parameter/gatekeeper/${ACTIVE_GAME.id}/*`
                ],
            })
        );

        // CloudWatch metrics don't support resource-level permissions for PutMetricData
        instanceRole.addToPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ["cloudwatch:PutMetricData"],
                resources: ["*"],
                conditions: {
                    "StringEquals": {
                        "cloudwatch:namespace": "GameServer"
                    }
                }
            })
        );

        // Scope EC2 actions to this specific instance
        // Note: The instance ID will be injected after creation
        instanceRole.addToPolicy(
            new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    "ec2:StopInstances",
                    "ec2:DescribeInstances"
                ],
                resources: [
                    // This will be replaced with the actual instance ARN once created
                    `arn:aws:ec2:${this.region}:${this.account}:instance/*`
                ],
                conditions: {
                    // Add condition to restrict actions to only this instance using tags
                    "StringEquals": {
                        "ec2:ResourceTag/Name": `${this.stackName}/GameServerInstance`
                    }
                }
            })
        );

        // Create user data script for EC2 instance
        const userData = UserData.forLinux();

        // Install essential packages
        userData.addCommands(
            "yum update -y",
            "yum install -y docker git amazon-cloudwatch-agent jq",
            "systemctl enable docker",
            "systemctl start docker"
        );

        // Configure CloudWatch agent for logs - create a simplified config
        userData.addCommands(
            'echo \'{"agent":{"metrics_collection_interval":60,"run_as_user":"root"},"logs":{"logs_collected":{"files":{"collect_list":[{"file_path":"/var/lib/docker/containers/*/*.log","log_group_name":"/gatekeeper/docker/containers","log_stream_name":"{instance_id}/{filename}","timezone":"UTC"}]}}},"metrics":{"metrics_collected":{"mem":{"measurement":["mem_used_percent"]},"disk":{"measurement":["disk_used_percent"],"resources":["/"]}},"append_dimensions":{"InstanceId":"${!aws:InstanceId}"}}}' + "'" + ' > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json',
            "amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"
        );

        // Format and mount the data volume
        userData.addCommands(
            // Wait for the device to be available
            "echo 'Waiting for data volume to be available...'",
            "while [ ! -e /dev/nvme1n1 ]; do sleep 1; done",

            // Check if the volume is already formatted
            "if ! blkid /dev/nvme1n1; then",
            "  echo 'Formatting data volume...'",
            "  mkfs -t ext4 /dev/nvme1n1",
            "fi",

            // Create mount point and add to fstab
            "mkdir -p /mnt/game-data",
            "echo '/dev/nvme1n1 /mnt/game-data ext4 defaults 0 2' >> /etc/fstab",
            "mount -a",

            // Persistent data dirs (bind-mount targets from the game profile's volumes).
            "mkdir -p /mnt/game-data/gamefiles",
            "mkdir -p /mnt/game-data/data",
            "chmod -R 755 /mnt/game-data"
        );

        // World seeding doesn't happen here: push a save with `cli world push`,
        // then `cli world restore` extracts it onto the live data volume via SSM
        // (scripts/game/restore-world.sh) — works any time, not just first boot.

        // Install Node.js (runs the dependency-free A2S query helper
        // a2s-query.js used by the on-host monitor). Straight from the AL2023
        // repos — Node 18, same major as the Lambdas. (The old AL2 +
        // nodesource curl|bash failed silently: AL2's glibc 2.26 is too old
        // for nodesource Node 18, leaving the host with no `node` at all.)
        userData.addCommands(
            "yum install -y nodejs"
        );

        // Write GATEKeeper host config (scripts source this). GAME_DOMAIN is the
        // derived <subdomain>.<BASE_DOMAIN>, used by the monitor's readiness ping
        // when set (it falls back to the public IP otherwise).
        userData.addCommands(
            // IMDSv2-aware metadata fetch. AL2023 AMIs ship imds-support=v2.0, so
            // instances launched from them default to HttpTokens=required — bare
            // IMDSv1 curls 401. Fetch a token first (works on optional too).
            'imds() { local t; t=$(curl -s -m 5 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"); curl -s -m 5 -H "X-aws-ec2-metadata-token: $t" "http://169.254.169.254/latest/meta-data/$1"; }',
            `echo "GATEKEEPER_BUCKET=${this.backupBucket.bucketName}" > /etc/gatekeeper.conf`,
            `echo "AWS_REGION=$(imds placement/region)" >> /etc/gatekeeper.conf`,
            `echo "GAME_DOMAIN=${gameDomain() ?? ''}" >> /etc/gatekeeper.conf`,
            "mkdir -p /etc/gatekeeper"
        );

        // Bootstrap the update-gatekeeper-scripts service (first boot only).
        // It syncs the profile-driven scripts + the emitted game-profile.json +
        // the systemd unit files from S3, so script changes ship without an AMI
        // rebuild. Game-agnostic: only scripts/game/ and game-profile.json.
        userData.addCommands(
            `cat > /etc/systemd/system/update-gatekeeper-scripts.service << 'EOF'
[Unit]
Description=Update GATEKeeper scripts, game profile and services from S3
After=network-online.target
Wants=network-online.target
Before=game-server.service game-monitor.service

[Service]
Type=oneshot
# Wait for IAM credentials to be available
ExecStartPre=/bin/bash -c 'echo "Waiting for IAM credentials..."; until T=$(curl -sf -m 2 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600") && curl -sf -m 2 -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/iam/security-credentials/ > /dev/null 2>&1; do echo "IAM credentials not ready, retrying..."; sleep 2; done; echo "IAM credentials available"'
# Sync the profile-driven scripts from S3
ExecStart=/bin/bash -c 'source /etc/gatekeeper.conf && echo "Syncing scripts from s3://$GATEKEEPER_BUCKET/scripts/game/..." && aws s3 sync "s3://$GATEKEEPER_BUCKET/scripts/game/" /usr/local/bin/ --exclude "*" --include "*.sh" --include "*.js" && chmod +x /usr/local/bin/*.sh && echo "Scripts synced"'
# Fetch the active game profile (single source of truth for the runtime)
ExecStartPost=/bin/bash -c 'source /etc/gatekeeper.conf && mkdir -p /etc/gatekeeper && aws s3 cp "s3://$GATEKEEPER_BUCKET/scripts/game/game-profile.json" /etc/gatekeeper/game-profile.json && echo "Game profile fetched"'
# Sync service files from S3 and reload systemd
ExecStartPost=/bin/bash -c 'source /etc/gatekeeper.conf && if aws s3 ls "s3://$GATEKEEPER_BUCKET/services/" > /dev/null 2>&1; then echo "Syncing service files..." && aws s3 sync "s3://$GATEKEEPER_BUCKET/services/" /etc/systemd/system/ --exclude "*" --include "*.service" && systemctl daemon-reload && echo "Service files synced"; else echo "No services directory in S3, skipping"; fi'
RemainAfterExit=yes
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF`,
            "systemctl daemon-reload",
            "systemctl enable update-gatekeeper-scripts.service",
            // Run the update service to download scripts, the game profile and service files
            "systemctl start update-gatekeeper-scripts.service"
        );

        // Enable and start the game server + the on-host A2S monitor (units
        // synced from S3 above). The monitor handles player count, the readiness
        // ping, and idle auto-shutdown by querying A2S on localhost.
        userData.addCommands(
            "systemctl daemon-reload",
            "systemctl enable game-server.service",
            "systemctl enable game-monitor.service",
            // Discord presence sidecar (bot online + player count while the
            // server runs). No-ops cleanly until the bot token is seeded via
            // `cli discord put-token`.
            "systemctl enable game-presence.service",
            "systemctl start game-server.service",
            "systemctl start game-monitor.service",
            "systemctl start game-presence.service"
        );

        // Create standalone EBS volume for game data
        // This volume survives EC2 instance replacements during CDK deploys
        // RemovalPolicy.RETAIN ensures the volume isn't deleted even if stack is destroyed
        const dataVolume = new CfnVolume(this, "GameDataVolume", {
            availabilityZone: this.vpc.availabilityZones[0],
            size: dataVolumeSize,
            volumeType: "gp3",
            encrypted: true,
            tags: [
                { key: "Name", value: "GameData" },
                { key: "Purpose", value: "Game world data and backups" },
            ],
        });
        dataVolume.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

        // Create Lambda for volume management (detaches volume from old instances during replacement)
        const volumeManagerFunction = new NodejsFunction(this, 'VolumeManagerFunction', {
            runtime: Runtime.NODEJS_18_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambdas/volume-manager.ts'),
            timeout: Duration.minutes(10),
            description: 'Manages EBS volume attachment for EC2 instance replacement',
        });

        // Grant the Lambda permission to manage EC2 volumes and instances
        volumeManagerFunction.addToRolePolicy(new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'ec2:DescribeVolumes',
                'ec2:DescribeInstances',
                'ec2:DetachVolume',
                'ec2:StopInstances',
            ],
            resources: ['*'], // EC2 describe actions require * resource
        }));

        // Create Custom Resource provider
        const volumeManagerProvider = new Provider(this, 'VolumeManagerProvider', {
            onEventHandler: volumeManagerFunction,
        });

        // Every input that forces a new instance, hashed into one value (see
        // replacementFingerprint). user-data is finished being built by this point.
        const deploymentVersion = replacementFingerprint(
            AMI_ID,
            instanceType.toString(),
            userData.render(),
        );

        // Custom Resource that ensures the volume is detached before instance creation
        const volumeDetach = new CustomResource(this, 'VolumeDetachResource', {
            serviceToken: volumeManagerProvider.serviceToken,
            properties: {
                VolumeId: dataVolume.ref,
                // Trigger update when deployment version changes
                DeploymentVersion: deploymentVersion,
            },
        });

        // Ensure volume is detached before creating new instance
        volumeDetach.node.addDependency(dataVolume);

        // Create EC2 instance with only root volume
        // Data volume is attached separately to survive instance replacements
        this.ec2Instance = new Instance(this, "GameServerInstance", {
            vpc: this.vpc,
            instanceType: instanceType,
            // AL2023: its repos carry Node 18 natively (AL2's glibc is too old
            // for any supported Node, which silently broke the A2S monitor).
            // PINNED, not latestAmazonLinux2023(): "latest" resolves to a fresh SSM
            // value whenever AWS rotates the image, so EVERY unrelated deploy (even a
            // Lambda-only change) silently triggered an instance replacement + the
            // volume hand-off. cdk diff hid it (the template held an SSM {{resolve}}
            // ref, not the literal id). Pinning means the AMI only changes when we
            // change AMI_ID — which the fingerprint then picks up on its own.
            machineImage: MachineImage.genericLinux({ 'us-west-2': AMI_ID }),
            securityGroup: securityGroup,
            userData: userData,
            // User-data runs only at first boot, so a changed bootstrap must
            // land on a NEW instance. Without this, a user-data-only deploy
            // updates the property in place but never re-executes it — and the
            // DeploymentVersion-driven volume-detach then orphans the data
            // volume (detached from an instance that was never replaced).
            // Pairs with the DeploymentVersion bump: replacement + volume hand-off.
            userDataCausesReplacement: true,
            role: instanceRole,
            blockDevices: [
                {
                    deviceName: "/dev/xvda",
                    volume: BlockDeviceVolume.ebs(10, {
                        volumeType: EbsDeviceVolumeType.GP3,
                        encrypted: true,
                    }),
                },
            ],
        });

        // Add deployment version tag to force replacement when needed
        Tags.of(this.ec2Instance).add('DeploymentVersion', deploymentVersion);

        // Ensure volume is detached from old instances before new instance is created
        this.ec2Instance.node.addDependency(volumeDetach);

        // Attach the data volume to the instance
        // This attachment is recreated when instance is replaced, but volume persists
        const volumeAttachment = new CfnVolumeAttachment(this, "GameDataVolumeAttachment", {
            device: "/dev/xvdf",
            instanceId: this.ec2Instance.instanceId,
            volumeId: dataVolume.ref,
        });

        // Create Lambda for automated backup cleanup
        const backupCleanupFunction = new NodejsFunction(this, 'BackupCleanupFunction', {
            runtime: Runtime.NODEJS_18_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambdas/cleanup-backups.ts'),
            environment: {
                BACKUP_BUCKET_NAME: this.backupBucket.bucketName,
                BACKUPS_TO_KEEP: backupsToKeep.toString(),
            },
            timeout: Duration.minutes(5),
        });

        // Grant the Lambda permission to access the S3 bucket
        this.backupBucket.grantReadWrite(backupCleanupFunction);

        // Create CloudWatch Event Rule to trigger the backup cleanup Lambda
        const rule = new Rule(this, 'BackupCleanupRule', {
            schedule: Schedule.rate(Duration.hours(backupFrequencyHours)),
        });

        // Add the Lambda as a target for the CloudWatch Event
        rule.addTarget(new LambdaFunction(backupCleanupFunction));

        // ====== DISCORD INTEGRATION ======

        // Use a unique parameter name based on stack ID to avoid conflicts in tests
        const parameterSuffix = this.node.tryGetContext('testing') ? `-${this.node.id}` : '';

        // Store backup bucket name in SSM for EC2 scripts to access
        new StringParameter(this, "BackupBucketParam", {
            parameterName: `/gatekeeper/${ACTIVE_GAME.id}/backup-bucket-name`,
            stringValue: this.backupBucket.bucketName,
            description: "S3 bucket name for game server backups",
        });

        // Auto-shutdown configuration (minutes of idle time before server stops).
        // Per-game default from the profile; AUTO_SHUTDOWN_MINUTES (.env) overrides
        // as an escape hatch. Set to "off"/"disabled" to disable. Retunable at
        // runtime via `cli config set auto-shutdown` (the monitor re-reads SSM).
        const autoShutdownMinutes =
            process.env.AUTO_SHUTDOWN_MINUTES || String(ACTIVE_GAME.autoShutdownMinutes ?? 15);
        new StringParameter(this, "AutoShutdownParam", {
            parameterName: `/gatekeeper/${ACTIVE_GAME.id}/auto-shutdown-minutes`,
            stringValue: autoShutdownMinutes,
            description: "Minutes of idle time before auto-shutdown (or 'off' to disable)",
        });

        // Boot-timeout safety net: if the server never comes online (e.g. a wedged
        // first boot / SteamCMD failure), the monitor stops the instance after this
        // many minutes so it can't bill indefinitely. Generous default — first boot
        // downloads several GB; later boots reuse the RETAIN'd EBS and are fast.
        const bootTimeoutMinutes =
            process.env.BOOT_TIMEOUT_MINUTES || String(ACTIVE_GAME.bootTimeoutMinutes ?? 45);
        new StringParameter(this, "BootTimeoutParam", {
            parameterName: `/gatekeeper/${ACTIVE_GAME.id}/boot-timeout-minutes`,
            stringValue: bootTimeoutMinutes,
            description: "Minutes to wait for first liveness before stopping a failed boot (or 'off')",
        });

        // Channel hygiene: hours after a session goes offline before its status
        // message auto-deletes. Profile default, MESSAGE_TTL_HOURS (.env) overrides,
        // `cli config set message-ttl` retunes live. 'off' keeps messages forever.
        const messageTtlHours =
            process.env.MESSAGE_TTL_HOURS || String(ACTIVE_GAME.messageTtlHours ?? 16);
        new StringParameter(this, "MessageTtlParam", {
            parameterName: `/gatekeeper/${ACTIVE_GAME.id}/message-ttl-hours`,
            stringValue: messageTtlHours,
            description: "Hours before a session's status message auto-deletes (or 'off' to keep)",
        });

        // Extend button: minutes of idle grace added per press. Profile default,
        // EXTEND_MINUTES (.env) overrides, `cli config set extend` retunes live.
        // 'off' disables the button entirely.
        const extendMinutes =
            process.env.EXTEND_MINUTES || String(ACTIVE_GAME.extendMinutes ?? 5);
        new StringParameter(this, "ExtendMinutesParam", {
            parameterName: `/gatekeeper/${ACTIVE_GAME.id}/extend-minutes`,
            stringValue: extendMinutes,
            description: "Minutes of idle grace the Extend button grants per press (or 'off' to disable)",
        });

        // Cost guardrails: AWS Budgets that email when monthly spend trends past a
        // threshold. Region-agnostic (unlike a CloudWatch billing alarm) and $0.
        // Opt-in via .env: set BILLING_ALERT_EMAIL. Two layers (see docs/budgets.md):
        //   1. Per-stack budget — scoped to THIS stack's resources via the
        //      aws:cloudformation:stack-name cost-allocation tag, so each game is
        //      tracked on its own (STACK_BUDGET_USD, default 13).
        //   2. One account-wide budget — unfiltered, the whole-account total incl.
        //      the domain renewal, tax, and other projects (BILLING_BUDGET_USD,
        //      default 30). Created by the DEFAULT_GAME stack only, so there is a
        //      single copy, not one identical clone per stack.
        // Both fire at 80% actual spend and on a forecast to exceed 100%, so a runaway
        // (e.g. an instance stuck on) is caught early.
        // ⚠️ The per-stack filter only captures data once the stack-name tag is
        // ACTIVATED as a cost-allocation tag — a one-time account-level step that is
        // NOT deployable via CDK (Billing console, or `aws ce
        // update-cost-allocation-tags-status`). Until then a per-stack budget reads $0.
        const billingEmail = process.env.BILLING_ALERT_EMAIL;
        if (billingEmail) {
            // 80%-actual + 100%-forecast notifications, shared by both budgets.
            const subscribers = [{ subscriptionType: "EMAIL", address: billingEmail }];
            const notificationsWithSubscribers = [
                {
                    notification: {
                        notificationType: "ACTUAL",
                        comparisonOperator: "GREATER_THAN",
                        threshold: 80,
                        thresholdType: "PERCENTAGE",
                    },
                    subscribers,
                },
                {
                    notification: {
                        notificationType: "FORECASTED",
                        comparisonOperator: "GREATER_THAN",
                        threshold: 100,
                        thresholdType: "PERCENTAGE",
                    },
                    subscribers,
                },
            ];

            const stackBudgetUsd = Number(process.env.STACK_BUDGET_USD || '13');
            new CfnBudget(this, "CostBudget", {
                budget: {
                    budgetName: `${this.stackName}-monthly-cost`,
                    budgetType: "COST",
                    timeUnit: "MONTHLY",
                    budgetLimit: { amount: stackBudgetUsd, unit: "USD" },
                    // Scope to this stack's own resources via the auto-applied tag.
                    costFilters: { TagKeyValue: [`aws:cloudformation:stack-name$${this.stackName}`] },
                },
                notificationsWithSubscribers,
            });
            new CfnOutput(this, "BillingBudget", {
                value: `$${stackBudgetUsd}/mo (this stack) -> ${billingEmail}`,
                description: `Per-stack AWS Budget alert for ${this.stackName}`,
            });

            // Account-wide total: exactly one, owned by the default game's stack.
            if (ACTIVE_GAME.id === DEFAULT_GAME) {
                const accountBudgetUsd = Number(process.env.BILLING_BUDGET_USD || '30');
                new CfnBudget(this, "AccountCostBudget", {
                    budget: {
                        budgetName: "account-total-monthly-cost",
                        budgetType: "COST",
                        timeUnit: "MONTHLY",
                        budgetLimit: { amount: accountBudgetUsd, unit: "USD" },
                    },
                    notificationsWithSubscribers,
                });
                new CfnOutput(this, "AccountBillingBudget", {
                    value: `$${accountBudgetUsd}/mo (account-wide) -> ${billingEmail}`,
                    description: "Account-wide AWS Budget alert (all stacks + untagged spend)",
                });
            }
        }

        // Note: Discord webhooks are now stored in SSM Parameter Store
        // Use /setup command in Discord to configure webhooks per guild

        // Per-game Discord app credentials. Mirrors the worlds config-split: each
        // game is its own Discord app, so its creds live in the gitignored
        // config/<game>.discord.json ({ appId, publicKey, botToken }). Falls back to
        // .env (DISCORD_BOT_PUBLIC_KEY / DISCORD_BOT_SECRET_TOKEN) when absent.
        // Config dir is overridable so tests point at committed fixtures instead of
        // the real (gitignored, secret-bearing) config/ — keeps secrets out of snapshots.
        const configDir = process.env.GATEKEEPER_CONFIG_DIR || path.join(__dirname, '../../config');
        const discordConfigPath = path.join(configDir, `${ACTIVE_GAME.id}.discord.json`);
        let discordCfg: { appId?: string; publicKey?: string; botToken?: string } = {};
        if (fs.existsSync(discordConfigPath)) {
            discordCfg = JSON.parse(fs.readFileSync(discordConfigPath, 'utf-8'));
            console.log(`Loaded Discord config from ${discordConfigPath}`);
        }

        // Create Lambda common environment variables
        const lambdaEnv: { [key: string]: string } = {
            SERVER_INSTANCE_ID: this.ec2Instance.instanceId,
            BACKUP_BUCKET_NAME: this.backupBucket.bucketName,
            DISCORD_BOT_PUBLIC_KEY: discordCfg.publicKey || process.env.DISCORD_BOT_PUBLIC_KEY || '',
            DISCORD_BOT_TOKEN: discordCfg.botToken || process.env.DISCORD_BOT_SECRET_TOKEN || '',
            // Active game profile (selects persona, ports, join strategy, etc.)
            GAME: process.env.GAME || 'abiotic-factor',
            // Shared base domain; the per-game subdomain (<subdomain>.<BASE_DOMAIN>)
            // is derived from the active profile for /gate join.
            BASE_DOMAIN: process.env.BASE_DOMAIN || '',
        };

        // Per-game world config (worlds + passwords) from the gitignored
        // config/<game>.worlds.json, passed to the lambdas as WORLDS_JSON. This
        // replaces the legacy WORLD_X_* env sprawl; falls back to it if absent.
        const worldsConfigPath = path.join(configDir, `${ACTIVE_GAME.id}.worlds.json`);
        if (fs.existsSync(worldsConfigPath)) {
            const worldsJson = fs.readFileSync(worldsConfigPath, 'utf-8');
            lambdaEnv.WORLDS_JSON = worldsJson;
            console.log(`Loaded world config from ${worldsConfigPath}`);

            // Seed the active world at deploy. The instance's very first boot
            // happens at deploy time, before any /gate start has written
            // active-world — without this seed it would run the image defaults
            // (passwordless, default save) until idle-shutdown. Normalized via
            // the same parser the lambdas use so the host script gets the
            // canonical shape. /gate start overwrites this parameter at runtime;
            // CloudFormation only resets it if the seeded value itself changes.
            const seedWorld = getDefaultWorldConfig(undefined, parseWorldConfigsFromJson(worldsJson));
            if (seedWorld) {
                new StringParameter(this, "ActiveWorldParam", {
                    parameterName: `/gatekeeper/${ACTIVE_GAME.id}/active-world`,
                    stringValue: JSON.stringify(seedWorld),
                    description: "Active world config (seeded at deploy; overwritten by /gate start)",
                });
                console.log(`Seeded active world: ${seedWorld.name} (${seedWorld.worldName})`);
            }
        }

        // Remove empty values to avoid test issues
        Object.keys(lambdaEnv).forEach(key => {
            if (!lambdaEnv[key]) {
                delete lambdaEnv[key];
            }
        });

        // Common Lambda properties
        const lambdaDefaultProps = {
            runtime: Runtime.NODEJS_18_X,
            timeout: Duration.minutes(15), // Maximum timeout for async Discord operations
            memorySize: 512, // Increased memory for better performance
            environment: lambdaEnv,
        };

        // Create Discord Commands Lambda function
        const commandsFunction = new NodejsFunction(this, "CommandsFunction", {
            ...lambdaDefaultProps,
            entry: path.join(__dirname, '../lambdas/commands.ts'),
            handler: "handler",
        });
        
        // Add CloudWatch log retention
        new LogGroup(this, 'CommandsFunctionLogGroup', {
            logGroupName: `/aws/lambda/${commandsFunction.functionName}`,
            retention: RetentionDays.ONE_DAY
        });

        // Grant EC2 permissions to the Commands Lambda function
        // DescribeInstances is a list operation and doesn't support resource-level permissions
        const ec2DescribePolicy = new PolicyStatement({
            actions: [
                "ec2:DescribeInstances",
            ],
            resources: ["*"],
        });

        // Start/Stop operations can be scoped to specific instance
        const ec2ControlPolicy = new PolicyStatement({
            actions: [
                "ec2:StartInstances",
                "ec2:StopInstances",
            ],
            resources: [
                `arn:aws:ec2:${this.region}:${this.account}:instance/${this.ec2Instance.instanceId}`
            ],
        });

        // Add permission for SSM document - scoped to specific document and instance
        // Note: AWS-RunShellScript is an AWS-owned document, so ARN has no account ID
        const ssmDocumentPolicy = new PolicyStatement({
            actions: [
                "ssm:SendCommand",
            ],
            resources: [
                `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
                `arn:aws:ec2:${this.region}:${this.account}:instance/${this.ec2Instance.instanceId}`
            ]
        });

        // Add permission for SSM command invocation
        const ssmCommandPolicy = new PolicyStatement({
            actions: [
                "ssm:GetCommandInvocation"
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:*`
            ]
        });

        // Add S3 policy for commands function: world seeds + mod-library
        // metadata (read by /gate mods to render names/links).
        const s3BackupPolicy = new PolicyStatement({
            actions: [
                "s3:ListBucket",
                "s3:GetObject"
            ],
            resources: [
                this.backupBucket.bucketArn,
                `${this.backupBucket.bucketArn}/worlds/*`,
                `${this.backupBucket.bucketArn}/mods/*`
            ]
        });

        // Add EventBridge policy for commands function (for force stop notifications)
        const eventBridgePolicy = new PolicyStatement({
            actions: [
                "events:PutEvents"
            ],
            resources: [
                `arn:aws:events:${this.region}:${this.account}:event-bus/default`
            ]
        });

        commandsFunction.addToRolePolicy(ec2DescribePolicy);
        commandsFunction.addToRolePolicy(ec2ControlPolicy);
        commandsFunction.addToRolePolicy(ssmDocumentPolicy);
        commandsFunction.addToRolePolicy(ssmCommandPolicy);
        commandsFunction.addToRolePolicy(s3BackupPolicy);
        commandsFunction.addToRolePolicy(eventBridgePolicy);

        // Grant SSM Parameter Store access to commands Lambda (full permissions)
        const ssmCommandsPolicy = new PolicyStatement({
            actions: [
                "ssm:GetParameter",
                "ssm:GetParameters",
                "ssm:PutParameter",  // For setup command
                "ssm:DeleteParameter",  // For cleanup
                "ssm:AddTagsToResource",  // For tagging parameters
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/gatekeeper/${ACTIVE_GAME.id}/*`
            ],
        });
        
        commandsFunction.addToRolePolicy(ssmCommandsPolicy);

        // --- Scheduled openings (Phase 11) ---------------------------------
        // /gate schedule creates one-time EventBridge Scheduler schedules in a
        // per-game group; they invoke this small Lambda to pre-warm the
        // instance and post countdown messages. Kept separate from the
        // commands Lambda so the Discord-facing role stays minimal.
        const schedulerFunction = new NodejsFunction(this, "SchedulerFunction", {
            ...lambdaDefaultProps,
            entry: path.join(__dirname, '../lambdas/scheduler.ts'),
            handler: "handler",
            timeout: Duration.minutes(2),
        });
        new LogGroup(this, 'SchedulerFunctionLogGroup', {
            logGroupName: `/aws/lambda/${schedulerFunction.functionName}`,
            retention: RetentionDays.ONE_DAY
        });
        schedulerFunction.addToRolePolicy(ec2ControlPolicy);
        schedulerFunction.addToRolePolicy(new PolicyStatement({
            actions: ["ssm:GetParameter", "ssm:PutParameter"],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/gatekeeper/${ACTIVE_GAME.id}/*`
            ],
        }));

        const scheduleGroup = new CfnScheduleGroup(this, "ScheduleGroup", {
            name: `gatekeeper-${ACTIVE_GAME.id}`,
        });

        // The role EventBridge Scheduler assumes to invoke the Lambda; the
        // commands Lambda passes it on CreateSchedule (hence the scoped PassRole).
        const schedulerInvokeRole = new Role(this, "SchedulerInvokeRole", {
            assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
            description: "Assumed by EventBridge Scheduler to fire GATEKeeper scheduled openings",
        });
        schedulerFunction.grantInvoke(schedulerInvokeRole);

        commandsFunction.addEnvironment("SCHEDULER_GROUP", scheduleGroup.name!);
        commandsFunction.addEnvironment("SCHEDULER_TARGET_ARN", schedulerFunction.functionArn);
        commandsFunction.addEnvironment("SCHEDULER_ROLE_ARN", schedulerInvokeRole.roleArn);
        // Input timezone for `/gate schedule set when:` — display uses Discord
        // native timestamps, so this only governs how typed times are read.
        commandsFunction.addEnvironment("SCHEDULE_TZ", process.env.SCHEDULE_TZ || "America/Los_Angeles");
        // Owner allowlist for spend-affecting commands (/gate config). Comma-
        // separated Discord user ids from .env; empty = fail closed (deny all).
        commandsFunction.addEnvironment("BOT_OWNER_IDS", process.env.BOT_OWNER_IDS || "");

        commandsFunction.addToRolePolicy(new PolicyStatement({
            actions: [
                "scheduler:CreateSchedule",
                "scheduler:DeleteSchedule",
                "scheduler:GetSchedule",
            ],
            resources: [
                `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`
            ],
        }));
        commandsFunction.addToRolePolicy(new PolicyStatement({
            actions: ["scheduler:ListSchedules"],
            resources: ["*"], // list op: no resource-level scoping
        }));
        commandsFunction.addToRolePolicy(new PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [schedulerInvokeRole.roleArn],
            conditions: {
                StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
            },
        }));
        // -------------------------------------------------------------------

        // Grant limited SSM access to backup cleanup function (read-only)
        const ssmBackupPolicy = new PolicyStatement({
            actions: [
                "ssm:GetParameter",
                "ssm:GetParameters",
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/gatekeeper/${ACTIVE_GAME.id}/*`
            ],
        });
        
        backupCleanupFunction.addToRolePolicy(ssmBackupPolicy);

        // Create API Gateway
        // Renamed from the huginbot-era "HuginbotApi" 2026-06-11 — a construct-ID
        // change REPLACES the API Gateway (new endpoint URL), so each game's
        // Discord Interactions Endpoint URL must be re-pasted in the Developer
        // Portal right after the deploy that carries this.
        const api = new RestApi(this, "GatekeeperApi", {
            restApiName: "GATEKeeper Discord API",
            description: "API for the Discord bot to control the game server",
            endpointTypes: [EndpointType.REGIONAL],
        });

        // Create API routes
        const interactionsResource = api.root.addResource("interactions");
        const commandsResource = interactionsResource.addResource("control");
        commandsResource.addMethod("POST", new LambdaIntegration(commandsFunction, {
            proxy: true,
        }));
        
        // Add CORS support for Discord
        commandsResource.addCorsPreflight({
            allowOrigins: ['https://discord.com'],
            allowMethods: ['POST', 'OPTIONS'],
            allowHeaders: ['Content-Type', 'X-Signature-Ed25519', 'X-Signature-Timestamp'],
        });

        this.apiUrl = api.url;

        // Create Discord notifications Lambda function (handles all EventBridge notifications)
        const discordNotificationsFunction = new NodejsFunction(this, 'DiscordNotificationsFunction', {
            ...lambdaDefaultProps,
            entry: path.join(__dirname, '../lambdas/discord-notifications.ts'),
            handler: 'handler',
            timeout: Duration.seconds(30),
        });

        // Grant SSM permissions for webhook and world config access, plus
        // PutParameter: on the stopped event this Lambda invalidates the
        // per-session join-code/server-live params (the catch-all stop path).
        discordNotificationsFunction.addToRolePolicy(new PolicyStatement({
            actions: [
                "ssm:GetParameter",
                "ssm:GetParameters",
                "ssm:PutParameter",
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/gatekeeper/${ACTIVE_GAME.id}/*`
            ],
        }));

        // Message TTL: on the stopped event this Lambda schedules a one-off delete
        // (the scheduler Lambda's delete-message action) for the session's status
        // message. Same Scheduler group/role/target as the openings feature.
        discordNotificationsFunction.addEnvironment("SCHEDULER_GROUP", scheduleGroup.name!);
        discordNotificationsFunction.addEnvironment("SCHEDULER_TARGET_ARN", schedulerFunction.functionArn);
        discordNotificationsFunction.addEnvironment("SCHEDULER_ROLE_ARN", schedulerInvokeRole.roleArn);
        discordNotificationsFunction.addToRolePolicy(new PolicyStatement({
            actions: ["scheduler:CreateSchedule"],
            resources: [
                `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`
            ],
        }));
        discordNotificationsFunction.addToRolePolicy(new PolicyStatement({
            actions: ["iam:PassRole"],
            resources: [schedulerInvokeRole.roleArn],
            conditions: {
                StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
            },
        }));

        // Readiness + idle/backup messages are posted directly to the webhook by
        // the on-host monitor, so the only EventBridge-driven notification left is
        // the final "server stopped" confirmation below (AWS emits the state-change
        // event after the host is gone, so only a Lambda can catch it).

        // Create EventBridge rule for EC2 instance state changes (final stopped notification)
        const ec2StateChangeRule = new Rule(this, 'EC2StateChangeRule', {
            eventPattern: {
                source: ['aws.ec2'],
                detailType: ['EC2 Instance State-change Notification'],
                detail: {
                    'instance-id': [this.ec2Instance.instanceId],
                    'state': ['stopped']
                }
            },
            description: 'Trigger notification when EC2 instance stops'
        });
        ec2StateChangeRule.addTarget(new LambdaFunction(discordNotificationsFunction));

        // === ROUTE 53 DERIVED DOMAIN (OPTIONAL) ===
        // When BASE_DOMAIN is set, each game gets <subdomain>.<BASE_DOMAIN> in the
        // one shared hosted zone (e.g. abiotic.gjurdsihop.net). A Lambda updates the
        // A record to the instance's public IP whenever it reaches the running state.
        const gameUrl = gameDomain();
        if (gameUrl) {
            console.log(`Derived game domain: ${gameUrl}`);
            const gamePort = ACTIVE_GAME.ports[0]?.from ?? ACTIVE_GAME.queryPort;

            // Create Lambda function to update Route53
            const route53UpdateFunction = new NodejsFunction(this, 'Route53UpdateFunction', {
                ...lambdaDefaultProps,
                entry: path.join(__dirname, '../lambdas/update-route53.ts'),
                handler: 'handler',
                timeout: Duration.seconds(30),
                environment: {
                    ...lambdaDefaultProps.environment,
                    CUSTOM_DOMAIN: gameUrl,
                },
            });

            // Grant permissions to read EC2 instance info
            route53UpdateFunction.addToRolePolicy(new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    'ec2:DescribeInstances',
                ],
                resources: ['*'], // DescribeInstances doesn't support resource-level permissions
            }));

            // Grant permissions to update Route53 records
            route53UpdateFunction.addToRolePolicy(new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                    'route53:ListHostedZonesByName',
                    'route53:ChangeResourceRecordSets',
                    'route53:GetChange', // Optional: check status of DNS changes
                ],
                resources: ['*'], // Route53 requires wildcard for ListHostedZonesByName
            }));

            // Create EventBridge rule for EC2 state changes (running state)
            const route53UpdateRule = new Rule(this, 'Route53UpdateRule', {
                eventPattern: {
                    source: ['aws.ec2'],
                    detailType: ['EC2 Instance State-change Notification'],
                    detail: {
                        'instance-id': [this.ec2Instance.instanceId],
                        'state': ['running']
                    }
                },
                description: `Update Route53 DNS when the ${ACTIVE_GAME.displayName} server starts`
            });

            route53UpdateRule.addTarget(new LambdaFunction(route53UpdateFunction));

            // Also pass the derived domain to the discord notifications lambda
            discordNotificationsFunction.addEnvironment('CUSTOM_DOMAIN', gameUrl);

            // Output the connect address
            new CfnOutput(this, "CustomDomain", {
                value: `${gameUrl}:${gamePort}`,
                description: `Domain for connecting to the ${ACTIVE_GAME.displayName} server`,
                exportName: `${this.stackName}-CustomDomain`,
            });
        }

        // Outputs
        new CfnOutput(this, "InstanceId", {
            value: this.ec2Instance.instanceId,
            description: "ID of the game server EC2 instance",
            exportName: `${this.stackName}-InstanceId`,
        });

        new CfnOutput(this, "InstancePublicIP", {
            value: "Get public IP with: aws ec2 describe-instances --instance-ids " + this.ec2Instance.instanceId + " --query 'Reservations[0].Instances[0].PublicIpAddress'",
            description: "Command to get the game server public IP",
            exportName: `${this.stackName}-PublicIP`,
        });

        new CfnOutput(this, "BackupBucketName", {
            value: this.backupBucket.bucketName,
            description: "S3 bucket for game server backups",
            exportName: `${this.stackName}-BackupBucket`,
        });

        // Discord integration outputs
        new CfnOutput(this, "ApiEndpoint", {
            value: api.url,
            description: "API Endpoint for Discord bot integration",
            exportName: `${this.stackName}-ApiEndpoint${parameterSuffix}`,
        });

    }

    private get removalPolicy() {
        return this.node.tryGetContext("production") === true
            ? undefined // Retain in production
            : this.node.tryGetContext("keep_resources") === true
                ? undefined // Retain if explicitly requested
                : undefined; // Default behavior (DESTROY would be safer for testing)
    }

}
