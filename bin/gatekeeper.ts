#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GameServerStack } from '../lib/server/game-server-stack';

const app = new cdk.App();

// Stack name is derived from the active game so each game deploys as its own
// isolated CloudFormation stack (e.g. GateStack-AbioticFactor) alongside any
// others on the account — including the live huginbot ValheimStack. See plan Phase 0.
const game = process.env.GAME || 'abiotic-factor';
const gamePascal = game
  .split(/[-_]/)
  .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
  .join('');
new GameServerStack(app, `GateStack-${gamePascal}`, {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },
});
