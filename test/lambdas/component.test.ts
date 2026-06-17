// SSM command classes — store the input so we can assert on PutParameter targets.
jest.mock('@aws-sdk/client-ssm', () => ({
  GetParameterCommand: jest.fn().mockImplementation((input: any) => ({ input, __type: 'Get' })),
  PutParameterCommand: jest.fn().mockImplementation((input: any) => ({ input, __type: 'Put' })),
}));

// aws-clients: mock the SSM client; withRetry passes through.
jest.mock('../../lib/lambdas/utils/aws-clients', () => {
  const mockSsmSend = jest.fn();
  (global as any).__mockSsmSend = mockSsmSend;
  return {
    ssmClient: { send: mockSsmSend },
    withRetry: async <T>(op: () => Promise<T>) => op(),
  };
});

// params: real keys/builders (requireActual); getExtendMinutes is a jest.fn().
jest.mock('../../lib/lambdas/utils/params', () => {
  const actual = jest.requireActual('../../lib/lambdas/utils/params');
  const mockGetExtendMinutes = jest.fn();
  (global as any).__mockGetExtendMinutes = mockGetExtendMinutes;
  return { ...actual, getExtendMinutes: mockGetExtendMinutes };
});

// Delegated handlers — return sentinels so dispatch is testable without their AWS deps.
jest.mock('../../lib/lambdas/commands/status', () => ({
  handleStatusCommand: jest.fn(async () => ({ statusCode: 200, body: 'STATUS' })),
}));
jest.mock('../../lib/lambdas/commands/stop', () => ({
  handleStopCommand: jest.fn(async () => ({ statusCode: 200, body: 'STOP' })),
}));
jest.mock('../../lib/lambdas/commands/open', () => ({
  handleOpenCommand: jest.fn(async () => ({ statusCode: 200, body: 'OPEN' })),
}));

import { handleComponentInteraction } from '../../lib/lambdas/commands/component';
import { handleStopCommand } from '../../lib/lambdas/commands/stop';
import { handleOpenCommand } from '../../lib/lambdas/commands/open';

const ssm = () => (global as any).__mockSsmSend as jest.Mock;
const extendMinutes = () => (global as any).__mockGetExtendMinutes as jest.Mock;
const parse = (res: any) => JSON.parse(res.body);

function click(customId: string) {
  return {
    type: 3,
    guild_id: 'g1',
    data: { custom_id: customId },
    message: { id: 'm1', embeds: [{ title: 'World', description: '🟢 Online' }] },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('status-message component dispatch', () => {
  test('gk_stop swaps to a two-step confirm row, preserving the embed', async () => {
    const body = parse(await handleComponentInteraction(click('gk_stop')));
    expect(body.type).toBe(7); // UPDATE_MESSAGE
    const ids = body.data.components[0].components.map((b: any) => b.custom_id);
    expect(ids).toEqual(['gk_stop_confirm', 'gk_stop_cancel']);
    expect(body.data.embeds).toEqual([{ title: 'World', description: '🟢 Online' }]);
  });

  test('gk_stop_cancel restores Stop + Extend when idle (0 players, feature on)', async () => {
    ssm().mockResolvedValue({ Parameter: { Value: '0' } });
    extendMinutes().mockResolvedValue(5);
    const body = parse(await handleComponentInteraction(click('gk_stop_cancel')));
    const ids = body.data.components[0].components.map((b: any) => b.custom_id);
    expect(ids).toEqual(['gk_stop', 'gk_extend']);
  });

  test('gk_stop_cancel hides Extend when players are online', async () => {
    ssm().mockResolvedValue({ Parameter: { Value: '3' } });
    extendMinutes().mockResolvedValue(5);
    const body = parse(await handleComponentInteraction(click('gk_stop_cancel')));
    const ids = body.data.components[0].components.map((b: any) => b.custom_id);
    expect(ids).toEqual(['gk_stop']);
  });

  test('gk_stop_confirm triggers backup-and-stop and clears the buttons', async () => {
    const body = parse(await handleComponentInteraction(click('gk_stop_confirm')));
    expect(handleStopCommand).toHaveBeenCalledWith('g1', false);
    expect(body.type).toBe(7);
    expect(body.data.components).toEqual([]); // buttons gone
    expect(body.data.embeds[0].description).toContain('Stopping');
  });

  test('gk_extend writes extend-until in the future and acks with the minutes', async () => {
    extendMinutes().mockResolvedValue(5);
    ssm().mockResolvedValue({});
    const before = Date.now();
    const body = parse(await handleComponentInteraction(click('gk_extend')));
    const put = ssm().mock.calls.map((c: any) => c[0]).find((c: any) => c.__type === 'Put');
    expect(put.input.Name).toBe('/gatekeeper/abiotic-factor/extend-until');
    expect(Number(put.input.Value)).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(body.type).toBe(4); // ephemeral ack
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('5 min');
  });

  test('gk_extend is a no-op ack when the feature is off', async () => {
    extendMinutes().mockResolvedValue('off');
    const body = parse(await handleComponentInteraction(click('gk_extend')));
    expect(ssm()).not.toHaveBeenCalled();
    expect(body.data.content).toMatch(/off/i);
  });

  test('gk_open delegates to handleOpenCommand with the guild id', async () => {
    const res = await handleComponentInteraction(click('gk_open'));
    expect(handleOpenCommand).toHaveBeenCalledWith('g1');
    expect(res.body).toBe('OPEN');
  });

  test('an unknown custom_id acks silently (DEFERRED_UPDATE_MESSAGE)', async () => {
    const body = parse(await handleComponentInteraction(click('nope')));
    expect(body.type).toBe(6);
  });
});
