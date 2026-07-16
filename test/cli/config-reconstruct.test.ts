// Unit tests for the pure `config reconstruct` helpers, which pull the gitignored
// config back out of a deployed CloudFormation template. IO-free, so we exercise
// them against a fixture template with no AWS calls.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const R = require('../../cli/lib/reconstruct');

// 'MTUxNDE0OTQ1MDAxOTUwODIyNA' is base64 of the real Valheim app id — so the
// decode is deterministic and matches production.
const TOKEN = 'MTUxNDE0OTQ1MDAxOTUwODIyNA.GLrTVN.faketokensignaturepart';
const APP_ID = '1514149450019508224';

const TEMPLATE = {
  Resources: {
    CommandsFunction05D33041: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Environment: {
          Variables: {
            WORLDS_JSON:
              '[{"name":"GjurdsIHOP","worldName":"GjurdsIHOP","password":"seabuds","discordServerId":"1085035922208342148","default":true}]',
            DISCORD_BOT_PUBLIC_KEY: 'a'.repeat(64),
            DISCORD_BOT_TOKEN: TOKEN,
            GAME: 'valheim',
            BASE_DOMAIN: 'gjurdsihop.net',
            BOT_OWNER_IDS: '433484689144152065',
            SCHEDULE_TZ: 'America/Los_Angeles',
            SERVER_INSTANCE_ID: { Ref: 'ServerInstance' }, // intrinsic — must be dropped
          },
        },
      },
    },
    BackupCleanupFunction: {
      Type: 'AWS::Lambda::Function',
      Properties: { Environment: { Variables: { BACKUPS_TO_KEEP: '7', BACKUP_BUCKET_NAME: { Ref: 'B' } } } },
    },
    MonthlyBudget: {
      Type: 'AWS::Budgets::Budget',
      Properties: {
        NotificationsWithSubscribers: [
          {
            Subscribers: [
              { SubscriptionType: 'SNS', Address: 'arn:aws:sns:...' },
              { SubscriptionType: 'EMAIL', Address: 'logandalec@gmail.com' },
            ],
          },
        ],
      },
    },
  },
};

describe('config reconstruct helpers', () => {
  test('lambdaEnvFromTemplate keeps string literals and drops intrinsics', () => {
    const env = R.lambdaEnvFromTemplate(TEMPLATE);
    expect(env.GAME).toBe('valheim');
    expect(env.BASE_DOMAIN).toBe('gjurdsihop.net');
    expect(env.WORLDS_JSON).toContain('GjurdsIHOP');
    expect('SERVER_INSTANCE_ID' in env).toBe(false); // intrinsic dropped
  });

  test('lambdaEnvFromTemplate falls back to any lambda carrying WORLDS_JSON', () => {
    const tpl = { Resources: { SomeOtherFn: TEMPLATE.Resources.CommandsFunction05D33041 } };
    expect(R.lambdaEnvFromTemplate(tpl).WORLDS_JSON).toContain('GjurdsIHOP');
  });

  test('billingEmailFromTemplate reads the EMAIL subscriber', () => {
    expect(R.billingEmailFromTemplate(TEMPLATE)).toBe('logandalec@gmail.com');
  });

  test('backupsToKeepFromTemplate reads the cleanup lambda', () => {
    expect(R.backupsToKeepFromTemplate(TEMPLATE)).toBe('7');
  });

  test('appIdFromToken decodes the token prefix', () => {
    expect(R.appIdFromToken(TOKEN)).toBe(APP_ID);
    expect(R.appIdFromToken('')).toBe('');
  });

  test('prettyWorldsJson round-trips valid JSON and returns null on garbage', () => {
    const env = R.lambdaEnvFromTemplate(TEMPLATE);
    const pretty = R.prettyWorldsJson(env.WORLDS_JSON);
    expect(pretty.endsWith('\n')).toBe(true);
    expect(JSON.parse(pretty)[0].name).toBe('GjurdsIHOP');
    expect(R.prettyWorldsJson('{not json')).toBeNull();
  });

  test('discordJson builds { appId, publicKey, botToken }', () => {
    const env = R.lambdaEnvFromTemplate(TEMPLATE);
    const obj = JSON.parse(R.discordJson(env));
    expect(obj).toEqual({ appId: APP_ID, publicKey: 'a'.repeat(64), botToken: TOKEN });
    expect(R.discordJson({})).toBeNull();
  });

  test('envFile includes shared config and omits Discord secrets', () => {
    const env = R.lambdaEnvFromTemplate(TEMPLATE);
    const out = R.envFile(env, {
      region: 'us-west-2',
      email: R.billingEmailFromTemplate(TEMPLATE),
      backupsToKeep: R.backupsToKeepFromTemplate(TEMPLATE),
      gameId: 'valheim',
    });
    expect(out).toContain('GAME=valheim');
    expect(out).toContain('AWS_REGION=us-west-2');
    expect(out).toContain('BASE_DOMAIN=gjurdsihop.net');
    expect(out).toContain('BOT_OWNER_IDS=433484689144152065');
    expect(out).toContain('BILLING_ALERT_EMAIL=logandalec@gmail.com');
    expect(out).toContain('BACKUPS_TO_KEEP=7');
    // Secrets must NOT land in .env — discord.json owns them.
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('DISCORD_BOT_TOKEN');
  });
});
