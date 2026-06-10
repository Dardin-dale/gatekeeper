import {
  parseWorldConfigsFromJson,
  loadWorldConfigs,
  getDefaultWorldConfig,
  validateWorldConfig,
  WorldConfig,
} from '../../lib/lambdas/utils/world-config';

describe('World Config Utilities', () => {
  describe('validateWorldConfig', () => {
    test('returns no errors for a valid config', () => {
      const validConfig: WorldConfig = {
        name: 'Test World',
        discordServerId: '12345678901234567',
        worldName: 'TestWorld',
        serverPassword: 'password123',
      };
      expect(validateWorldConfig(validConfig)).toHaveLength(0);
    });

    test('validates the name field', () => {
      const config: WorldConfig = {
        name: '',
        discordServerId: '123456789',
        worldName: 'TestWorld',
        serverPassword: 'password123',
      };
      expect(validateWorldConfig(config).some(e => e.includes('name'))).toBeTruthy();
      config.name = 'AB';
      expect(validateWorldConfig(config).some(e => e.includes('name'))).toBeTruthy();
    });

    test('validates the world save name field', () => {
      const config: WorldConfig = {
        name: 'Valid Name',
        discordServerId: '123456789',
        worldName: '',
        serverPassword: 'password123',
      };
      expect(validateWorldConfig(config).some(e => e.includes('save name'))).toBeTruthy();
      config.worldName = 'Invalid-Characters!';
      expect(
        validateWorldConfig(config).some(e => e.includes('letters, numbers, and underscores')),
      ).toBeTruthy();
    });

    test('validates the server password field', () => {
      const config: WorldConfig = {
        name: 'Valid Name',
        discordServerId: '123456789',
        worldName: 'ValidWorld',
        serverPassword: '',
      };
      expect(validateWorldConfig(config).some(e => e.includes('password'))).toBeTruthy();
      config.serverPassword = 'pass';
      expect(validateWorldConfig(config).some(e => e.includes('password'))).toBeTruthy();
    });

    test('validates the mods field', () => {
      const config: WorldConfig = {
        name: 'Valid Name',
        discordServerId: '123456789',
        worldName: 'ValidWorld',
        serverPassword: 'password123',
        mods: ['CoolMod', 'Better_Lights-2.0'],
      };
      expect(validateWorldConfig(config)).toHaveLength(0);

      config.mods = ['../escape'];
      expect(validateWorldConfig(config).some(e => e.includes('Invalid mod name'))).toBeTruthy();
      config.mods = ['has spaces'];
      expect(validateWorldConfig(config).some(e => e.includes('Invalid mod name'))).toBeTruthy();
      config.mods = 'CoolMod' as unknown as string[];
      expect(validateWorldConfig(config).some(e => e.includes('must be an array'))).toBeTruthy();
    });

    test('parses mods through to the world config (empty list dropped)', () => {
      const worlds = parseWorldConfigsFromJson(JSON.stringify([
        {
          name: 'Modded', worldName: 'ModdedSave', password: 'password123',
          discordServerId: '123456789', mods: ['CoolMod'],
        },
        {
          name: 'Vanilla', worldName: 'VanillaSave', password: 'password123',
          discordServerId: '123456789', mods: [],
        },
      ]));
      expect(worlds).toHaveLength(2);
      expect(worlds[0].mods).toEqual(['CoolMod']);
      expect(worlds[1].mods).toBeUndefined();
    });

    test('validates the discordServerId field', () => {
      const config: WorldConfig = {
        name: 'Valid Name',
        discordServerId: 'not-a-number',
        worldName: 'ValidWorld',
        serverPassword: 'password123',
      };
      expect(validateWorldConfig(config).some(e => e.includes('Discord'))).toBeTruthy();
    });
  });

  describe('parseWorldConfigsFromJson / loadWorldConfigs', () => {
    const originalEnv = process.env;
    afterEach(() => { process.env = originalEnv; });

    test('parses worlds from a JSON array, mapping password -> serverPassword', () => {
      const json = JSON.stringify([
        { name: 'MainWorld', worldName: 'Cascade', password: 'changeme', discordServerId: '123456' },
      ]);
      const configs = parseWorldConfigsFromJson(json);
      expect(configs).toHaveLength(1);
      expect(configs[0]).toEqual({
        name: 'MainWorld',
        worldName: 'Cascade',
        serverPassword: 'changeme',
        discordServerId: '123456',
      });
    });

    test('returns [] for bad JSON or a non-array, and skips invalid worlds', () => {
      expect(parseWorldConfigsFromJson('not json')).toEqual([]);
      expect(parseWorldConfigsFromJson('{}')).toEqual([]);
      const oneValidOneBad = JSON.stringify([
        { name: 'GoodWorld', worldName: 'Cascade', password: 'ok123', discordServerId: '1' },
        { name: 'Y' }, // too short + missing worldName -> skipped
      ]);
      expect(parseWorldConfigsFromJson(oneValidOneBad)).toHaveLength(1);
    });

    test('loadWorldConfigs reads WORLDS_JSON (and is empty without it)', () => {
      process.env = { ...originalEnv };
      delete process.env.WORLDS_JSON;
      expect(loadWorldConfigs()).toEqual([]);

      process.env.WORLDS_JSON = JSON.stringify([
        { name: 'FromJson', worldName: 'Cascade', password: 'changeme', discordServerId: '999' },
      ]);
      const configs = loadWorldConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0].name).toBe('FromJson');
    });

    test('getDefaultWorldConfig resolves per-guild (flagged default, else that guild\'s first)', () => {
      const configs = parseWorldConfigsFromJson(JSON.stringify([
        { name: 'GuildOneA', worldName: 'Alpha', password: 'ok123', discordServerId: '1' },
        { name: 'GuildOneB', worldName: 'Beta', password: 'ok123', discordServerId: '1', default: true },
        { name: 'GuildTwo', worldName: 'Gamma', password: 'ok123', discordServerId: '2' },
      ]));
      expect(getDefaultWorldConfig('1', configs)?.name).toBe('GuildOneB'); // guild 1's flagged default
      expect(getDefaultWorldConfig('2', configs)?.name).toBe('GuildTwo');  // guild 2's only world
      expect(getDefaultWorldConfig('999', configs)?.name).toBe('GuildOneB'); // unknown guild -> global default
      expect(getDefaultWorldConfig(undefined, configs)?.name).toBe('GuildOneB');
    });
  });
});
