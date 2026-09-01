/**
 * util/join-info renders the per-game join fields shared by /<cmd> join and
 * /<cmd> status. Run against the Valheim profile because it is the one
 * join-code game — and its code is OPTIONAL: only worlds started with
 * `-crossplay` (PlayFab) mint one. A vanilla world leaves SSM at the 'none'
 * sentinel, and the Join Code field must simply be absent, never "none".
 */
process.env.GAME = 'valheim';

jest.mock('../../lib/lambdas/utils/aws-clients', () => {
  const mockSsmSend = jest.fn();
  (global as any).__mockSsmSend = mockSsmSend;
  return {
    ssmClient: { send: mockSsmSend },
    ec2Client: { send: jest.fn() },
    s3Client: { send: jest.fn() },
    SERVER_INSTANCE_ID: 'i-1234567890abcdef0',
    BACKUP_BUCKET_NAME: 'test-backup-bucket',
  };
});

import { buildJoinFields, joinHint } from '../../lib/lambdas/commands/util/join-info';
import { SSM_PARAMS } from '../../lib/lambdas/utils/params';

const mockSsmSend = (global as any).__mockSsmSend as jest.Mock;

function mockSsm(values: Record<string, string>): void {
  mockSsmSend.mockImplementation(async (cmd: any) => {
    const name = cmd.input?.Name as string;
    if (name in values) return { Parameter: { Value: values[name] } };
    throw new Error(`ParameterNotFound: ${name}`);
  });
}

const activeWorld = JSON.stringify({ name: 'MainWorld', worldName: 'Midgard', serverPassword: 'hunter2' });

describe('join-info (Valheim: join code is per-world optional)', () => {
  beforeEach(() => mockSsmSend.mockReset());

  it('vanilla world (no -crossplay): address + password only, no Join Code field', async () => {
    mockSsm({ [SSM_PARAMS.ACTIVE_WORLD]: activeWorld, [SSM_PARAMS.JOIN_CODE]: 'none' });
    const fields = await buildJoinFields('valheim.example.net');
    expect(fields.map((f) => f.name)).toEqual(['🌐 Address', '🔑 Password']);
    // addressWithPort: one copyable "host:port" on the GAME port (in-game Join IP).
    expect(fields[0].value).toContain('valheim.example.net:2456');
    expect(fields[1].value).toContain('hunter2');
    expect(JSON.stringify(fields)).not.toContain('none');
  });

  it('crossplay world: the scraped code renders as a Join Code field', async () => {
    mockSsm({ [SSM_PARAMS.ACTIVE_WORLD]: activeWorld, [SSM_PARAMS.JOIN_CODE]: '487341' });
    const fields = await buildJoinFields('valheim.example.net');
    expect(fields.map((f) => f.name)).toEqual(['🌐 Address', '🔑 Password', '🎟️ Join Code']);
    expect(fields[2].value).toContain('487341');
  });

  it('no active world / no code in SSM: still renders the address', async () => {
    mockSsm({});
    const fields = await buildJoinFields('1.2.3.4');
    expect(fields.map((f) => f.name)).toEqual(['🌐 Address']);
    expect(fields[0].value).toContain('1.2.3.4:2456');
  });

  it('the hint reads correctly with or without a code (crossplay is opt-in)', () => {
    const hint = joinHint() ?? '';
    expect(hint).toMatch(/Join IP/);
    expect(hint).toMatch(/2457/);        // Steam server browser uses the query port
    expect(hint).not.toMatch(/posted here/); // no promise of a code that vanilla never mints
  });
});
