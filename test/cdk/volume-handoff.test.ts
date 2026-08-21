import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GameServerStack } from '../../lib/server/game-server-stack';

/**
 * The data-volume hand-off must be a transaction: the detach custom resource
 * fires on every DeploymentVersion change, so a matching attach verifier must
 * fire on the same trigger, after the instance and the CfnVolumeAttachment.
 * Without it, a version change with no instance replacement ends the deploy
 * with the volume detached (2026-08-21: Valheim's worlds volume was orphaned
 * exactly this way).
 */
function synth() {
  const stack = new GameServerStack(new App(), 'FingerprintStack', {
    env: { account: '123456789012', region: 'us-west-2' },
  } as any);
  return Template.fromStack(stack);
}

function customResources(template: Template) {
  const all = template.findResources('AWS::CloudFormation::CustomResource');
  const entries = Object.entries(all) as Array<[string, any]>;
  const detach = entries.find(([id]) => id.startsWith('VolumeDetachResource'));
  const verify = entries.find(([id]) => id.startsWith('VolumeAttachVerifyResource'));
  return { detach, verify };
}

describe('volume hand-off pairing', () => {
  it('has an ensure-attached verifier for every detach', () => {
    const { detach, verify } = customResources(synth());
    expect(detach).toBeDefined();
    expect(verify).toBeDefined();
    expect(verify![1].Properties.Action).toBe('ensure-attached');
    expect(verify![1].Properties.Device).toBe('/dev/xvdf');
  });

  it('triggers the verifier on exactly the same DeploymentVersion as the detach', () => {
    const template = synth();
    const { detach, verify } = customResources(template);
    const version = detach![1].Properties.DeploymentVersion;
    expect(typeof version).toBe('string');
    expect(verify![1].Properties.DeploymentVersion).toBe(version);

    const inst = Object.values(template.findResources('AWS::EC2::Instance'))[0] as any;
    const tag = inst.Properties.Tags.find((t: any) => t.Key === 'DeploymentVersion');
    expect(tag.Value).toBe(version);
  });

  it('runs the verifier only after the attachment and the instance', () => {
    const template = synth();
    const { verify } = customResources(template);
    const deps: string[] = verify![1].DependsOn ?? [];
    expect(deps.some((d) => d.startsWith('GameDataVolumeAttachment'))).toBe(true);
    expect(deps.some((d) => d.startsWith('GameServerInstance'))).toBe(true);
  });
});
