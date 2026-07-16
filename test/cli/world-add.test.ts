// Unit tests for the CLI `world add` builder. The CLI is plain CommonJS JS, so
// we require it directly; buildWorld is pure (no IO), which is why it's exported.
// The key guard here is the cross-check: a world buildWorld accepts must also
// pass the authoritative validateWorldConfig used at deploy — so the CLI's
// inline validation can never silently diverge from the real gate.
import { validateWorldConfig, WorldConfig } from '../../lib/lambdas/utils/world-config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildWorld } = require('../../cli/commands/world');

interface RawWorld {
  name: string;
  worldName: string;
  password: string;
  discordServerId?: string;
  adminIds?: string;
  default?: boolean;
  extraArgs?: string;
  mods?: string[];
}

// The file uses `password`; validateWorldConfig wants `serverPassword`.
function asWorldConfig(w: RawWorld): WorldConfig {
  return {
    name: w.name,
    worldName: w.worldName,
    serverPassword: w.password,
    discordServerId: w.discordServerId ?? '',
    adminIds: w.adminIds,
    default: w.default,
    extraArgs: w.extraArgs,
    mods: w.mods,
  };
}

const GUILD = '1085035922208342148';
const roster: RawWorld[] = [
  { name: 'GjurdsIHOP', worldName: 'GjurdsIHOP', password: 'seabuds', discordServerId: GUILD, default: true },
];

describe('world add — buildWorld', () => {
  test('builds a valid world and it passes the authoritative validator', () => {
    const { world, errors } = buildWorld(roster, {
      name: 'buttermilk',
      password: 'seabuds',
      guild: GUILD,
      args: '-crossplay',
      mods: ['BetterNetworking_Valheim'],
    });
    expect(errors).toEqual([]);
    expect(world.name).toBe('buttermilk');
    // Cross-check: the deploy-time gate must also accept it.
    expect(validateWorldConfig(asWorldConfig(world))).toHaveLength(0);
  });

  test('derives an ASCII save name from the friendly name when --world is omitted', () => {
    const { world, errors } = buildWorld([], { name: 'Main World', password: 'seabuds', guild: GUILD });
    expect(world.worldName).toBe('MainWorld');
    expect(errors).toEqual([]);
  });

  test('transliterates Norse/Latin letters into a valid ASCII save name', () => {
    const { world, errors } = buildWorld([], { name: 'Emmumóðir', password: 'seabuds', guild: GUILD });
    expect(errors).toEqual([]);
    expect(world.worldName).toBe('Emmumodir'); // ó -> o, ð -> d
    expect(validateWorldConfig(asWorldConfig(world))).toHaveLength(0);
  });

  test('a non-Latin name that cannot reduce to ASCII needs an explicit --world', () => {
    const auto = buildWorld([], { name: 'Мир', password: 'seabuds', guild: GUILD });
    expect(auto.errors.some((e: string) => /worldName/.test(e))).toBe(true);
    const explicit = buildWorld([], { name: 'Мир', world: 'Peace', password: 'seabuds', guild: GUILD });
    expect(explicit.errors).toEqual([]);
    expect(explicit.world.worldName).toBe('Peace');
    expect(validateWorldConfig(asWorldConfig(explicit.world))).toHaveLength(0);
  });

  test('rejects a duplicate name (case-insensitive)', () => {
    const { errors } = buildWorld(roster, { name: 'gjurdsihop', password: 'seabuds', guild: GUILD });
    expect(errors.some((e: string) => /already exists/.test(e))).toBe(true);
  });

  test('rejects a duplicate worldName even when the label differs', () => {
    const { errors } = buildWorld(roster, { name: 'Pancakes', world: 'GjurdsIHOP', password: 'seabuds', guild: GUILD });
    expect(errors.some((e: string) => /already in use/.test(e))).toBe(true);
  });

  test('rejects a second default in the same guild', () => {
    const { errors } = buildWorld(roster, { name: 'buttermilk', password: 'seabuds', guild: GUILD, default: true });
    expect(errors.some((e: string) => /already the default/.test(e))).toBe(true);
  });

  test('allows a default in a different guild', () => {
    const { errors } = buildWorld(roster, { name: 'buttermilk', password: 'seabuds', guild: '999999999999999999', default: true });
    expect(errors).toEqual([]);
  });

  test('rejects a short password and an invalid mod name', () => {
    const short = buildWorld([], { name: 'buttermilk', password: 'no', guild: GUILD });
    expect(short.errors.some((e: string) => /password/.test(e))).toBe(true);
    const badMod = buildWorld([], { name: 'buttermilk', password: 'seabuds', guild: GUILD, mods: ['../evil'] });
    expect(badMod.errors.some((e: string) => /mod name/.test(e))).toBe(true);
  });
});
