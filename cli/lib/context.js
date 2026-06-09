'use strict';
// Shared CLI context: which game is active, the derived stack name, and helpers
// to discover deployed resources from CloudFormation outputs. Game-aware by
// construction — everything keys off GAME (default abiotic-factor), mirroring
// the CDK app (bin/valheim-ec2-cdk.ts) so the CLI targets the right stack.

const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

const GAME_ID = process.env.GAME || 'abiotic-factor';
const REGION = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-west-2';

// 'abiotic-factor' -> 'AbioticFactor' (matches the CDK stack-name derivation).
const pascal = GAME_ID.split('-')
  .filter(Boolean)
  .map((s) => s[0].toUpperCase() + s.slice(1))
  .join('');
const STACK_NAME = `GateStack-${pascal}`;

let _outputs;
async function stackOutputs() {
  if (_outputs) return _outputs;
  const cf = new CloudFormationClient({ region: REGION });
  let res;
  try {
    res = await cf.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  } catch (err) {
    throw new Error(
      `Could not read stack ${STACK_NAME} in ${REGION}. Is it deployed (npm run deploy) ` +
      `and is GAME/AWS_REGION set correctly? (${err.message})`
    );
  }
  const outs = res.Stacks && res.Stacks[0] && res.Stacks[0].Outputs;
  _outputs = {};
  for (const o of outs || []) _outputs[o.OutputKey] = o.OutputValue;
  return _outputs;
}

async function stackOutput(key) {
  const outs = await stackOutputs();
  if (!(key in outs)) {
    throw new Error(`Output '${key}' not found on ${STACK_NAME}. Available: ${Object.keys(outs).join(', ') || '(none)'}`);
  }
  return outs[key];
}

module.exports = { GAME_ID, REGION, STACK_NAME, stackOutput };
