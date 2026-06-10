import { getGameProfile, GAME_PROFILES, DEFAULT_GAME, runtimeProfile } from '../../lib/games';
import { abioticFactor } from '../../lib/games/abiotic-factor';
import { valheim } from '../../lib/games/valheim';

describe('game profile registry', () => {
  it('resolves abiotic-factor by id', () => {
    expect(getGameProfile('abiotic-factor')).toBe(abioticFactor);
  });

  it('defaults to abiotic-factor', () => {
    expect(getGameProfile(DEFAULT_GAME).id).toBe('abiotic-factor');
  });

  it('throws loudly on an unknown game', () => {
    expect(() => getGameProfile('halflife')).toThrow(/Unknown GAME 'halflife'/);
  });

  it('every registered profile satisfies the contract invariants', () => {
    for (const [key, p] of Object.entries(GAME_PROFILES)) {
      expect(p.id).toBe(key); // registry key matches profile id
      expect(p.container.image).toBeTruthy();
      expect(p.container.envMap.password).toBeTruthy(); // password mapping is required
      expect(p.ports.length).toBeGreaterThan(0);
      expect(p.queryPort).toBeGreaterThan(0); // A2S monitoring requires a query port
      expect(p.persona.hailQuotes.length).toBeGreaterThan(0);
    }
  });

  it('abiotic factor exposes an A2S query port and address-based join', () => {
    expect(abioticFactor.queryPort).toBe(27015);
    expect(abioticFactor.join).toMatchObject({ type: 'address', port: 7777 });
    expect(abioticFactor.ports.some((r) => r.from === 7777)).toBe(true);
  });
});

describe('mods spec', () => {
  it('every declared mod kind installs inside a persistent volume mount', () => {
    // targetPath must live under a bind-mounted host dir, or installed mods
    // would silently vanish on instance replacement.
    for (const p of Object.values(GAME_PROFILES)) {
      for (const [kind, k] of Object.entries(p.mods?.kinds ?? {})) {
        const covered = p.container.volumes.some((v) => k.targetPath.startsWith(v.hostPath + '/'));
        expect({ game: p.id, kind, covered }).toEqual({ game: p.id, kind, covered: true });
      }
    }
  });

  it('abiotic factor supports pak mods, manually sourced, with client matching', () => {
    expect(Object.keys(abioticFactor.mods!.kinds)).toEqual(['pak']);
    expect(abioticFactor.mods!.kinds.pak.targetPath).toContain('/Content/Paks');
    expect(abioticFactor.mods!.source).toMatchObject({ type: 'manual' });
    expect(abioticFactor.mods!.clientsMustMatch).toBe(true);
  });

  it('valheim expresses the huginbot model: bepinex plugins from thunderstore', () => {
    const kind = valheim.mods!.kinds['bepinex-plugin'];
    expect(kind.targetPath).toBe('/mnt/game-data/config/bepinex/plugins');
    expect(kind.env).toEqual({ BEPINEX: 'true' });
    expect(valheim.mods!.source).toMatchObject({ type: 'thunderstore', community: 'valheim' });
  });

  it('runtimeProfile emits modKinds for the host installer (empty when unmodded)', () => {
    expect(runtimeProfile(abioticFactor).modKinds).toEqual(abioticFactor.mods!.kinds);
    const unmodded = { ...abioticFactor, mods: undefined };
    expect(runtimeProfile(unmodded).modKinds).toEqual({});
  });
});
