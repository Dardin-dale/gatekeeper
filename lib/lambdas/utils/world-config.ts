// A world = a save + its access config, mapped to a Discord server.
export interface WorldConfig {
  name: string;                // Friendly label (menus/logs)
  discordServerId: string;     // Discord server that controls this world
  worldName: string;           // Save/world folder name on disk
  serverPassword: string;      // Server password
  adminIds?: string;           // Admin Steam IDs (space-separated)
  default?: boolean;           // The world /gate start loads when none is specified
  extraArgs?: string;          // Per-world launch args, appended to the profile's defaultArgs
                               // (e.g. Valheim's '-crossplay -modifier combat hard')
  mods?: string[];             // S3 mod-library entries to install for this world
  overrides?: Record<string, unknown>; // Optional container env overrides
}

/**
 * Mod names key S3 paths (mods/<Name>/...) and host file paths, so they're
 * restricted to a path- and shell-safe charset. Enforced here, by the CLI on
 * `mods add`, and re-checked by the host installer.
 */
export const MOD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a world configuration. Returns an array of error messages
 * (empty if valid).
 */
export function validateWorldConfig(worldConfig: WorldConfig): string[] {
  const errors: string[] = [];

  if (!worldConfig.name || worldConfig.name.trim() === '') {
    errors.push('World name cannot be empty');
  } else if (worldConfig.name.length < 3) {
    errors.push('World name must be at least 3 characters');
  } else if (worldConfig.name.length > 50) {
    errors.push('World name cannot exceed 50 characters');
  }

  if (!worldConfig.worldName || worldConfig.worldName.trim() === '') {
    errors.push('World save name cannot be empty');
  } else if (worldConfig.worldName.length < 3) {
    errors.push('World save name must be at least 3 characters');
  } else if (worldConfig.worldName.length > 64) {
    errors.push('World save name cannot exceed 64 characters');
  } else if (!/^[a-zA-Z0-9_]+$/.test(worldConfig.worldName)) {
    errors.push('World save name can only contain letters, numbers, and underscores');
  }

  if (!worldConfig.serverPassword || worldConfig.serverPassword.trim() === '') {
    errors.push('Server password cannot be empty');
  } else if (worldConfig.serverPassword.length < 5) {
    errors.push('Server password must be at least 5 characters');
  }

  if (worldConfig.discordServerId && !/^\d+$/.test(worldConfig.discordServerId)) {
    errors.push('Discord server ID must be a numeric value');
  }

  if (worldConfig.mods !== undefined) {
    if (!Array.isArray(worldConfig.mods)) {
      errors.push('mods must be an array of mod library names');
    } else {
      for (const mod of worldConfig.mods) {
        if (typeof mod !== 'string' || !MOD_NAME_PATTERN.test(mod)) {
          errors.push(`Invalid mod name '${mod}' (letters, digits, . _ - only)`);
        }
      }
    }
  }

  return errors;
}

/**
 * Shape of an entry in config/<game>.worlds.json (the gitignored, per-game
 * world config). `password`/`discordServerId` are canonical; `serverPassword`/
 * `discordId` are accepted as aliases.
 */
interface RawWorld {
  name: string;
  worldName: string;
  password?: string;
  serverPassword?: string;
  discordServerId?: string;
  discordId?: string;
  adminIds?: string;
  default?: boolean;
  extraArgs?: string;
  serverArgs?: string; // huginbot-era alias for extraArgs
  mods?: string[];
  overrides?: Record<string, unknown>;
}

/**
 * Parse worlds from a JSON array string (config/<game>.worlds.json, passed to
 * the Lambda as WORLDS_JSON). Invalid worlds are logged and skipped.
 */
export function parseWorldConfigsFromJson(json: string): WorldConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    console.error('Invalid WORLDS_JSON (could not parse):', error);
    return [];
  }
  if (!Array.isArray(raw)) {
    console.error('WORLDS_JSON must be a JSON array of worlds');
    return [];
  }

  const configs: WorldConfig[] = [];
  for (const entry of raw as RawWorld[]) {
    const config: WorldConfig = {
      name: entry.name,
      worldName: entry.worldName,
      serverPassword: entry.serverPassword ?? entry.password ?? '',
      discordServerId: entry.discordServerId ?? entry.discordId ?? '',
      adminIds: entry.adminIds || undefined,
      default: entry.default || undefined,
      extraArgs: entry.extraArgs ?? entry.serverArgs ?? undefined,
      mods: entry.mods && entry.mods.length > 0 ? entry.mods : undefined,
      overrides: entry.overrides,
    };
    const errors = validateWorldConfig(config);
    if (errors.length > 0) {
      console.error(`Skipping invalid world '${entry.name}':`, errors);
    } else {
      configs.push(config);
    }
  }
  // Guard: at most one default per guild.
  const defaultsByGuild = new Map<string, number>();
  for (const c of configs) {
    if (c.default) {
      defaultsByGuild.set(c.discordServerId, (defaultsByGuild.get(c.discordServerId) ?? 0) + 1);
    }
  }
  for (const [guild, count] of defaultsByGuild) {
    if (count > 1) {
      console.warn(`Guild ${guild} has ${count} worlds flagged 'default'; the first will be used.`);
    }
  }

  console.log(`Loaded ${configs.length} world(s) from WORLDS_JSON`);
  return configs;
}

/** Load world configs for the active game from WORLDS_JSON. */
export function loadWorldConfigs(): WorldConfig[] {
  return process.env.WORLDS_JSON ? parseWorldConfigsFromJson(process.env.WORLDS_JSON) : [];
}

export const WORLD_CONFIGS = loadWorldConfigs();

/**
 * The world `/gate start` loads for a guild when none is specified. Resolution is
 * per-guild: among that guild's worlds, the one flagged `default`, else its first;
 * then falling back to any globally-flagged default, else the first world overall.
 */
export function getDefaultWorldConfig(
  guildId?: string,
  configs: WorldConfig[] = WORLD_CONFIGS,
): WorldConfig | undefined {
  if (guildId) {
    const guildWorlds = configs.filter((w) => w.discordServerId === guildId);
    const guildDefault = guildWorlds.find((w) => w.default) ?? guildWorlds[0];
    if (guildDefault) return guildDefault;
  }
  return configs.find((w) => w.default) ?? configs[0];
}
