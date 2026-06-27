import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GameServerStack } from '../../lib/server/game-server-stack';

describe('GameServerStack', () => {
  let app: cdk.App;
  let stack: GameServerStack;
  let template: Template;

  beforeAll(() => {
    // Override env with test values so real secrets can't leak into snapshots.
    // (.env is loaded by the stack, but already-set env vars take precedence.)
    process.env.DISCORD_BOT_PUBLIC_KEY = 'test-public-key';
    process.env.DISCORD_BOT_SECRET_TOKEN = 'test-secret-token';

    // Point the stack's config reads (worlds/discord json) at committed
    // fixtures instead of the real, gitignored, secret-bearing config/.
    process.env.GATEKEEPER_CONFIG_DIR = path.join(__dirname, '../fixtures/config');

    // Create stack once for all tests (faster)
    app = new cdk.App({
      context: {
        testing: true,  // Signal to stack that this is a test run
      },
    });

    stack = new GameServerStack(app, 'TestGameStack', {
      env: {
        account: '123456789012',
        region: 'us-west-2',
      },
    });

    template = Template.fromStack(stack);
  });

  describe('Snapshot Tests', () => {
    test('stack matches snapshot', () => {
      // This will fail if infrastructure changes unexpectedly
      // Update snapshot with: npm test -- -u

      // Get template and sanitize dynamic values before snapshot comparison
      const templateJson = template.toJSON();

      expect(templateJson).toMatchSnapshot();
    });
  });

  describe('Cost guardrail budgets', () => {
    const prev = {
      email: process.env.BILLING_ALERT_EMAIL,
      account: process.env.BILLING_BUDGET_USD,
      stack: process.env.STACK_BUDGET_USD,
    };

    function synth(stackId: string): Template {
      const a = new cdk.App({ context: { testing: true } });
      const s = new GameServerStack(a, stackId, {
        env: { account: '123456789012', region: 'us-west-2' },
      });
      return Template.fromStack(s);
    }

    afterAll(() => {
      // Restore so other suites synth budget-free as before.
      process.env.BILLING_ALERT_EMAIL = prev.email;
      process.env.BILLING_BUDGET_USD = prev.account;
      process.env.STACK_BUDGET_USD = prev.stack;
    });

    test('no budgets unless BILLING_ALERT_EMAIL is set', () => {
      delete process.env.BILLING_ALERT_EMAIL;
      synth('NoEmailStack').resourceCountIs('AWS::Budgets::Budget', 0);
    });

    test('the default game stack gets a per-stack budget (tag-scoped) + the account-wide budget', () => {
      process.env.BILLING_ALERT_EMAIL = 'alerts@example.com';
      process.env.BILLING_BUDGET_USD = '30';
      process.env.STACK_BUDGET_USD = '13';
      // No GAME override -> active game is the default (abiotic-factor), so this
      // stack owns BOTH budgets.
      const t = synth('GateStack-AbioticFactor');

      t.resourceCountIs('AWS::Budgets::Budget', 2);

      // Per-stack: $13, filtered to this stack's own cloudformation:stack-name tag.
      t.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: {
          BudgetName: 'GateStack-AbioticFactor-monthly-cost',
          BudgetLimit: { Amount: 13, Unit: 'USD' },
          CostFilters: { TagKeyValue: ['aws:cloudformation:stack-name$GateStack-AbioticFactor'] },
        },
      });

      // Account-wide: $30, no cost filter (whole-account total).
      t.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: {
          BudgetName: 'account-total-monthly-cost',
          BudgetLimit: { Amount: 30, Unit: 'USD' },
          CostFilters: Match.absent(),
        },
      });
    });
  });

  describe('EC2 Instance Configuration', () => {
    test('creates an EC2 instance', () => {
      template.resourceCountIs('AWS::EC2::Instance', 1);
    });

    test('EC2 instance has encrypted root volume', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        BlockDeviceMappings: Match.arrayWith([
          Match.objectLike({
            DeviceName: '/dev/xvda',
            Ebs: Match.objectLike({
              Encrypted: true,
            }),
          }),
        ]),
      });
    });

    test('EC2 instance uses the active profile instance type (t3.large for AF)', () => {
      template.hasResourceProperties('AWS::EC2::Instance', {
        InstanceType: 't3.large',
      });
    });
  });

  describe('Data Volume Configuration', () => {
    test('creates an EBS data volume', () => {
      template.resourceCountIs('AWS::EC2::Volume', 1);
    });

    test('data volume is encrypted', () => {
      template.hasResourceProperties('AWS::EC2::Volume', {
        Encrypted: true,
        VolumeType: 'gp3',
      });
    });

    test('data volume has RETAIN removal policy', () => {
      // Ensure data volume won't be deleted when stack is destroyed
      const volumes = template.findResources('AWS::EC2::Volume');
      const volumeLogicalId = Object.keys(volumes)[0];
      expect(volumes[volumeLogicalId].DeletionPolicy).toBe('Retain');
    });
  });

  describe('Security Group Configuration', () => {
    test('creates a security group', () => {
      template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    });

    test('exposes the game UDP port from the active profile (7777)', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            IpProtocol: 'udp',
            FromPort: 7777,
            ToPort: 7777,
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      });
    });

    test('exposes the Steam query port (27015 UDP)', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        SecurityGroupIngress: Match.arrayWith([
          Match.objectLike({
            IpProtocol: 'udp',
            FromPort: 27015,
            ToPort: 27015,
            CidrIp: '0.0.0.0/0',
          }),
        ]),
      });
    });
  });

  describe('S3 Backup Bucket Configuration', () => {
    test('creates an S3 bucket for backups', () => {
      template.resourceCountIs('AWS::S3::Bucket', 1);
    });

    test('backup bucket has versioning enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        VersioningConfiguration: {
          Status: 'Enabled',
        },
      });
    });
  });

  describe('IAM Role Configuration', () => {
    test('creates IAM role for EC2 instance', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: {
                Service: 'ec2.amazonaws.com',
              },
            }),
          ]),
        }),
      });
    });

    test('EC2 role has SSM managed policy for remote access', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([
                Match.stringLikeRegexp('AmazonSSMManagedInstanceCore'),
              ]),
            ]),
          }),
        ]),
      });
    });

    test('EC2 role has scoped S3 permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:PutObject', 's3:GetObject', 's3:ListBucket']),
              Effect: 'Allow',
              // Should have bucket-specific resources
              Resource: Match.anyValue(),
            }),
          ]),
        }),
      });
    });

    test('EC2 role has scoped SSM Parameter Store permissions', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter', 'ssm:GetParameters', 'ssm:PutParameter']),
              Effect: 'Allow',
              Resource: Match.stringLikeRegexp('parameter/gatekeeper'),
            }),
          ]),
        }),
      });
    });
  });

  describe('Lambda Functions', () => {
    test('creates backup cleanup Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
      });
    });

    test('creates Discord commands Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x',
        Timeout: 900, // 15 minutes in seconds
      });
    });

    test('creates Discord notifications Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs18.x',
        Timeout: 30,
      });
    });
  });

  describe('API Gateway Configuration', () => {
    test('creates REST API for Discord integration', () => {
      template.hasResourceProperties('AWS::ApiGateway::RestApi', {
        Name: 'GATEKeeper Discord API',
      });
    });

    test('API has interactions/control endpoint', () => {
      template.hasResourceProperties('AWS::ApiGateway::Resource', {
        PathPart: 'control',
      });
    });
  });

  describe('EventBridge Rules', () => {
    test('creates rule for backup cleanup schedule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        ScheduleExpression: Match.stringLikeRegexp('rate'),
      });
    });

    test('creates rule for EC2 state changes', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          source: ['aws.ec2'],
          'detail-type': ['EC2 Instance State-change Notification'],
        }),
      });
    });
  });

  describe('SSM Parameters', () => {
    test('creates backup bucket name parameter', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/gatekeeper/abiotic-factor/backup-bucket-name',
        Description: 'S3 bucket name for game server backups',
      });
    });

    test('creates auto-shutdown parameter', () => {
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/gatekeeper/abiotic-factor/auto-shutdown-minutes',
        Description: Match.stringLikeRegexp('auto-shutdown'),
      });
    });

    test('seeds active-world from the default world in worlds.json', () => {
      // Ensures the first boot (at deploy, before any /gate start) runs the
      // default world with its password instead of the passwordless image defaults.
      template.hasResourceProperties('AWS::SSM::Parameter', {
        Name: '/gatekeeper/abiotic-factor/active-world',
        Value: Match.stringLikeRegexp('TestCascade'),
      });
    });
  });

  describe('Outputs', () => {
    test('outputs instance ID', () => {
      template.hasOutput('InstanceId', {
        Description: Match.stringLikeRegexp('EC2 instance'),
      });
    });

    test('outputs backup bucket name', () => {
      template.hasOutput('BackupBucketName', {
        Description: Match.stringLikeRegexp('backup'),
      });
    });

    test('outputs API endpoint', () => {
      template.hasOutput('ApiEndpoint', {
        Description: Match.stringLikeRegexp('Discord'),
      });
    });
  });
});
