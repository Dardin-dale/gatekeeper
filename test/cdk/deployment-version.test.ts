import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { GameServerStack } from '../../lib/server/game-server-stack';

/**
 * DeploymentVersion drives both the volume-detach custom resource and the
 * instance tag. It must move for changes that REPLACE the instance, and must NOT
 * move for changes that merely mutate it.
 *
 * The second half is not academic: on 2026-08-21 the fingerprint included
 * instance type, so a t3.medium -> t3.large bump fired the detach with no
 * replacement to pair with. CloudFormation updates instance type in place, so
 * nothing reattached the volume and the server came up with no worlds mounted.
 */
// A fresh App each time, but always the SAME stack id: user-data embeds the stack
// name, so varying the id would move the fingerprint for reasons unrelated to the
// thing under test.
function versionFor(instanceType?: InstanceType): string {
  const stack = new GameServerStack(new App(), 'FingerprintStack', {
    env: { account: '123456789012', region: 'us-west-2' },
    ...(instanceType ? { instanceType } : {}),
  } as any);
  const inst = Object.values(Template.fromStack(stack).findResources('AWS::EC2::Instance'))[0] as any;
  return inst.Properties.Tags.find((t: any) => t.Key === 'DeploymentVersion').Value;
}

describe('DeploymentVersion fingerprint', () => {
  it('is identical across two synths of the same configuration', () => {
    // Non-determinism here detaches the data volume on EVERY deploy. An earlier
    // version hashed userData.render(), which is full of CDK tokens whose ids
    // depend on allocation order — so it failed exactly this assertion.
    expect(versionFor()).toBe(versionFor());
  });

  it('does NOT change when only the instance type changes', () => {
    // The 2026-08-21 regression, pinned. Instance type is an in-place update, so
    // moving the version detaches the data volume with nothing to reattach it.
    const medium = versionFor(InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM));
    const large = versionFor(InstanceType.of(InstanceClass.T3, InstanceSize.LARGE));
    expect(medium).toBe(large);
  });

  it('the tag and the volume-detach property always agree', () => {
    // Drift between them is the "volume already attached" rollback.
    const app = new App();
    const stack = new GameServerStack(app, 'PairStack', {
      env: { account: '123456789012', region: 'us-west-2' },
    } as any);
    const t = Template.fromStack(stack);
    const inst = Object.values(t.findResources('AWS::EC2::Instance'))[0] as any;
    const tagValue = inst.Properties.Tags.find((x: any) => x.Key === 'DeploymentVersion').Value;
    const custom = Object.values(t.findResources('AWS::CloudFormation::CustomResource'))
      .concat(Object.values(t.findResources('Custom::VolumeManager')))
      .find((r: any) => r.Properties?.DeploymentVersion) as any;
    expect(custom).toBeDefined();
    expect(custom.Properties.DeploymentVersion).toBe(tagValue);
  });
});
