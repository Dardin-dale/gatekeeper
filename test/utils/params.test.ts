// The SSM params module is the single owner of GATEKeeper's parameter surface;
// these cover the parse-or-default rules that used to be hand-rolled per caller.
const mockSsmSend = jest.fn();
jest.mock('../../lib/lambdas/utils/aws-clients', () => ({
  ssmClient: { send: (...args: any[]) => mockSsmSend(...args) },
}));

import {
  getActiveWorld,
  getJoinCode,
  getNumberParam,
  getServerLive,
  getSessionPrivate,
  SSM_PARAMS,
} from '../../lib/lambdas/utils/params';

const resolveValue = (value: string) =>
  mockSsmSend.mockResolvedValue({ Parameter: { Value: value } });
const missing = () => mockSsmSend.mockRejectedValue({ name: 'ParameterNotFound' });

beforeEach(() => mockSsmSend.mockReset());

describe('getNumberParam', () => {
  test('returns the fallback when the parameter is absent', async () => {
    missing();
    expect(await getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5)).toBe(5);
  });

  test('parses a positive integer', async () => {
    resolveValue('20');
    expect(await getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5)).toBe(20);
  });

  test('falls back on a non-positive or non-numeric value', async () => {
    resolveValue('0');
    expect(await getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5)).toBe(5);
    resolveValue('nonsense');
    expect(await getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5)).toBe(5);
  });

  test("returns 'off' for the disabled sentinels only when allowOff", async () => {
    resolveValue('off');
    expect(await getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5, true)).toBe('off');
    resolveValue('off');
    expect(await getNumberParam(SSM_PARAMS.EXTEND_MINUTES, 5)).toBe(5);
  });
});

describe('getActiveWorld', () => {
  test('parses a stored WorldConfig', async () => {
    resolveValue(JSON.stringify({ name: 'Aldwin', worldName: 'aldwin_save' }));
    const w = await getActiveWorld();
    expect(w?.name).toBe('Aldwin');
  });

  test('returns undefined (not a throw) on corrupt JSON', async () => {
    resolveValue('{ not valid json');
    await expect(getActiveWorld()).resolves.toBeUndefined();
  });

  test('returns undefined when unset', async () => {
    missing();
    await expect(getActiveWorld()).resolves.toBeUndefined();
  });
});

describe('boolean + sentinel accessors', () => {
  test('getServerLive defaults to true when the flag is missing', async () => {
    missing();
    expect(await getServerLive()).toBe(true);
    resolveValue('false');
    expect(await getServerLive()).toBe(false);
  });

  test('getSessionPrivate is true only for the literal "true"', async () => {
    resolveValue('true');
    expect(await getSessionPrivate()).toBe(true);
    resolveValue('false');
    expect(await getSessionPrivate()).toBe(false);
    missing();
    expect(await getSessionPrivate()).toBe(false);
  });

  test("getJoinCode maps 'none'/absent to undefined", async () => {
    resolveValue('none');
    expect(await getJoinCode()).toBeUndefined();
    resolveValue('ABC123');
    expect(await getJoinCode()).toBe('ABC123');
  });
});
