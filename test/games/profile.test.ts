import { getGameProfile, GAME_PROFILES, DEFAULT_GAME } from '../../lib/games';
import { abioticFactor } from '../../lib/games/abiotic-factor';

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
