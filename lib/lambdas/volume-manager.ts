/**
 * Volume Manager Lambda
 *
 * Custom Resource handler behind BOTH halves of the data-volume hand-off:
 *
 *   Action 'detach' (default)      - before the instance updates: detach the
 *                                    volume from whatever holds it (stopping the
 *                                    instance first) so a replacement can pick
 *                                    it up.
 *   Action 'ensure-attached'       - after the instance + CfnVolumeAttachment:
 *                                    verify the volume ended up attached, and
 *                                    attach it ourselves if not.
 *
 * The pairing is the point. A DeploymentVersion change always fires the detach,
 * but CloudFormation only re-attaches when the instance was genuinely replaced
 * (CfnVolumeAttachment keys on instanceId). Any update that changes the version
 * WITHOUT replacing the instance used to leave the volume orphaned — that is
 * exactly how the Valheim data volume was lost on 2026-08-21. The verifier turns
 * detach-then-maybe-attach into a transaction: the deploy cannot succeed until
 * the volume is attached again.
 */

import { EC2Client, DescribeVolumesCommand, DetachVolumeCommand, AttachVolumeCommand, DescribeInstancesCommand, StopInstancesCommand, waitUntilVolumeAvailable, waitUntilVolumeInUse, waitUntilInstanceStopped } from '@aws-sdk/client-ec2';

const ec2 = new EC2Client({});

interface CloudFormationEvent {
    RequestType: 'Create' | 'Update' | 'Delete';
    ResponseURL: string;
    StackId: string;
    RequestId: string;
    ResourceType: string;
    LogicalResourceId: string;
    PhysicalResourceId?: string;
    ResourceProperties: {
        VolumeId: string;
        Action?: 'detach' | 'ensure-attached';
        InstanceId?: string;   // ensure-attached: the instance that must hold the volume
        Device?: string;       // ensure-attached: device name, e.g. /dev/xvdf
        CurrentInstanceId?: string;
    };
}

interface CloudFormationResponse {
    Status: 'SUCCESS' | 'FAILED';
    Reason?: string;
    PhysicalResourceId: string;
    StackId: string;
    RequestId: string;
    LogicalResourceId: string;
    Data?: Record<string, string>;
}

async function sendResponse(event: CloudFormationEvent, response: CloudFormationResponse): Promise<void> {
    const responseBody = JSON.stringify(response);
    console.log('Response:', responseBody);

    const https = await import('https');
    const url = new URL(event.ResponseURL);

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': responseBody.length,
            },
        }, (res) => {
            console.log('CloudFormation response status:', res.statusCode);
            resolve();
        });

        req.on('error', (err) => {
            console.error('Error sending response:', err);
            reject(err);
        });

        req.write(responseBody);
        req.end();
    });
}

async function getVolumeAttachment(volumeId: string): Promise<{ instanceId: string; state: string } | null> {
    try {
        const result = await ec2.send(new DescribeVolumesCommand({
            VolumeIds: [volumeId],
        }));

        const volume = result.Volumes?.[0];
        if (volume?.Attachments && volume.Attachments.length > 0) {
            const attachment = volume.Attachments[0];
            return {
                instanceId: attachment.InstanceId || '',
                state: attachment.State || '',
            };
        }
        return null;
    } catch (error) {
        console.error('Error describing volume:', error);
        return null;
    }
}

async function getInstanceState(instanceId: string): Promise<string> {
    try {
        const result = await ec2.send(new DescribeInstancesCommand({
            InstanceIds: [instanceId],
        }));

        const instance = result.Reservations?.[0]?.Instances?.[0];
        return instance?.State?.Name || 'unknown';
    } catch (error) {
        console.error('Error describing instance:', error);
        return 'unknown';
    }
}

async function stopInstance(instanceId: string): Promise<void> {
    console.log(`Stopping instance ${instanceId}...`);

    await ec2.send(new StopInstancesCommand({
        InstanceIds: [instanceId],
    }));

    // Wait for instance to stop (max 5 minutes)
    await waitUntilInstanceStopped(
        { client: ec2, maxWaitTime: 300 },
        { InstanceIds: [instanceId] }
    );

    console.log(`Instance ${instanceId} stopped`);
}

async function detachVolume(volumeId: string, instanceId: string): Promise<void> {
    console.log(`Detaching volume ${volumeId} from instance ${instanceId}...`);

    await ec2.send(new DetachVolumeCommand({
        VolumeId: volumeId,
        InstanceId: instanceId,
        Force: false,
    }));

    // Wait for volume to become available (max 5 minutes)
    await waitUntilVolumeAvailable(
        { client: ec2, maxWaitTime: 300 },
        { VolumeIds: [volumeId] }
    );

    console.log(`Volume ${volumeId} detached and available`);
}

async function attachVolume(volumeId: string, instanceId: string, device: string): Promise<void> {
    console.log(`Attaching volume ${volumeId} to instance ${instanceId} at ${device}...`);

    await ec2.send(new AttachVolumeCommand({
        VolumeId: volumeId,
        InstanceId: instanceId,
        Device: device,
    }));

    await waitUntilVolumeInUse(
        { client: ec2, maxWaitTime: 300 },
        { VolumeIds: [volumeId] }
    );

    console.log(`Volume ${volumeId} attached to ${instanceId}`);
}

/**
 * ensure-attached: runs AFTER the instance and CfnVolumeAttachment on every
 * DeploymentVersion change. If the detach half fired without a paired
 * replacement, the volume is sitting 'available' here — attach it back. If the
 * instance is running when that happens, stop it: it booted without its data
 * volume, so whatever it is serving is wrong, and the fleet's steady state is
 * stopped-until-someone-starts-it anyway. The next /start boots with the
 * volume present and mounts it normally.
 */
async function ensureAttached(volumeId: string, instanceId: string, device: string): Promise<string> {
    const attachment = await getVolumeAttachment(volumeId);

    if (attachment && attachment.instanceId === instanceId) {
        console.log(`Volume ${volumeId} already attached to ${instanceId} (state: ${attachment.state})`);
        return 'already-attached';
    }

    if (attachment && attachment.instanceId) {
        // Attached to some OTHER instance: never steal it — fail the deploy loudly.
        throw new Error(
            `Volume ${volumeId} is attached to unexpected instance ${attachment.instanceId} ` +
            `(expected ${instanceId}). Refusing to force a hand-off.`
        );
    }

    await attachVolume(volumeId, instanceId, device);

    const state = await getInstanceState(instanceId);
    if (state === 'running') {
        console.log(`Instance ${instanceId} booted without the data volume; stopping so the next start mounts it`);
        await stopInstance(instanceId);
    }
    return 'reattached';
}

export async function handler(event: CloudFormationEvent): Promise<void> {
    console.log('Event:', JSON.stringify(event, null, 2));

    const volumeId = event.ResourceProperties.VolumeId;
    const currentInstanceId = event.ResourceProperties.CurrentInstanceId;
    const action = event.ResourceProperties.Action || 'detach';
    // Distinct physical ids per action so the two resources never alias.
    const physicalResourceId = event.PhysicalResourceId
        || (action === 'ensure-attached' ? `volume-attach-${volumeId}` : `volume-manager-${volumeId}`);

    try {
        if (event.RequestType === 'Delete') {
            // Nothing to do on delete - the volume persists
            await sendResponse(event, {
                Status: 'SUCCESS',
                PhysicalResourceId: physicalResourceId,
                StackId: event.StackId,
                RequestId: event.RequestId,
                LogicalResourceId: event.LogicalResourceId,
            });
            return;
        }

        if (action === 'ensure-attached') {
            const instanceId = event.ResourceProperties.InstanceId;
            const device = event.ResourceProperties.Device || '/dev/xvdf';
            if (!instanceId) {
                throw new Error('ensure-attached requires InstanceId');
            }
            const outcome = await ensureAttached(volumeId, instanceId, device);
            await sendResponse(event, {
                Status: 'SUCCESS',
                PhysicalResourceId: physicalResourceId,
                StackId: event.StackId,
                RequestId: event.RequestId,
                LogicalResourceId: event.LogicalResourceId,
                Data: { VolumeId: volumeId, Outcome: outcome },
            });
            return;
        }

        // detach (default): check if volume is attached to a different instance
        const attachment = await getVolumeAttachment(volumeId);

        if (attachment && attachment.instanceId && attachment.instanceId !== currentInstanceId) {
            console.log(`Volume ${volumeId} is attached to ${attachment.instanceId} (state: ${attachment.state})`);

            // Check if the attached instance is running
            const instanceState = await getInstanceState(attachment.instanceId);
            console.log(`Instance ${attachment.instanceId} state: ${instanceState}`);

            if (instanceState === 'running') {
                // Stop the instance first for safe detachment
                await stopInstance(attachment.instanceId);
            }

            // Detach the volume if it's in 'attached' state
            if (attachment.state === 'attached') {
                await detachVolume(volumeId, attachment.instanceId);
            }
        } else if (attachment) {
            console.log(`Volume ${volumeId} is already attached to current instance or in state: ${attachment.state}`);
        } else {
            console.log(`Volume ${volumeId} is not attached to any instance`);
        }

        await sendResponse(event, {
            Status: 'SUCCESS',
            PhysicalResourceId: physicalResourceId,
            StackId: event.StackId,
            RequestId: event.RequestId,
            LogicalResourceId: event.LogicalResourceId,
            Data: {
                VolumeId: volumeId,
                PreviousInstanceId: attachment?.instanceId || 'none',
            },
        });
    } catch (error) {
        console.error('Error:', error);
        await sendResponse(event, {
            Status: 'FAILED',
            Reason: error instanceof Error ? error.message : 'Unknown error',
            PhysicalResourceId: physicalResourceId,
            StackId: event.StackId,
            RequestId: event.RequestId,
            LogicalResourceId: event.LogicalResourceId,
        });
    }
}
