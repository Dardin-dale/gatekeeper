// Unit tests for the CLI `world switch` resolver. resolveSwitch is pure (no IO),
// so we exercise guild inference + world matching + the SSM param path directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSwitch } = require('../../cli/commands/world');

const GUILD = '1085035922208342148';
const OTHER = '999999999999999999';

const roster = [
  { name: 'GjurdsIHOP', worldName: 'GjurdsIHOP', discordServerId: GUILD, default: true },
  { name: 'buttermilk', worldName: 'Buttermilk', discordServerId: GUILD },
  { name: 'Emmumóðir', worldName: 'Emmumodir', discordServerId: GUILD },
];

describe('world switch — resolveSwitch', () => {
  test('infers the single guild and matches by name', () => {
    const r = resolveSwitch(roster, { name: 'buttermilk', gameId: 'valheim' });
    expect(r.errors).toEqual([]);
    expect(r.guild).toBe(GUILD);
    expect(r.match.name).toBe('buttermilk');
    expect(r.param).toBe(`/gatekeeper/valheim/discord/${GUILD}/default-world`);
  });

  test('matches by the ASCII worldName too (case-insensitive)', () => {
    const r = resolveSwitch(roster, { name: 'emmumodir', gameId: 'valheim' });
    expect(r.errors).toEqual([]);
    expect(r.match.name).toBe('Emmumóðir'); // resolves to the friendly label
  });

  test('rejects a world not in the guild and lists the options', () => {
    const r = resolveSwitch(roster, { name: 'nope', gameId: 'valheim' });
    expect(r.match).toBeUndefined();
    expect(r.errors[0]).toMatch(/no world 'nope'/);
    expect(r.errors[0]).toContain('GjurdsIHOP, buttermilk');
  });

  test('cannot infer a guild when the roster spans several', () => {
    const multi = [...roster, { name: 'other', worldName: 'Other', discordServerId: OTHER }];
    const r = resolveSwitch(multi, { name: 'buttermilk', gameId: 'valheim' });
    expect(r.guild).toBeUndefined();
    expect(r.errors[0]).toMatch(/could not infer --guild/);
  });

  test('honors an explicit --guild against a multi-guild roster', () => {
    const multi = [...roster, { name: 'other', worldName: 'Other', discordServerId: OTHER }];
    const r = resolveSwitch(multi, { name: 'other', guild: OTHER, gameId: 'valheim' });
    expect(r.errors).toEqual([]);
    expect(r.match.name).toBe('other');
    expect(r.guildWorlds).toHaveLength(1);
    expect(r.param).toBe(`/gatekeeper/valheim/discord/${OTHER}/default-world`);
  });

  test('with no name, still resolves the guild + its worlds (the "show" path)', () => {
    const r = resolveSwitch(roster, { gameId: 'valheim' });
    expect(r.errors).toEqual([]);
    expect(r.match).toBeUndefined();
    expect(r.guildWorlds.map((w: { name: string }) => w.name)).toEqual(['GjurdsIHOP', 'buttermilk', 'Emmumóðir']);
  });
});
