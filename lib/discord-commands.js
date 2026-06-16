/**
 * Discord slash-command schema for GATEKeeper.
 *
 * Everything lives under a single top-level `/gate` command (subcommands) so it
 * never collides with another bot's `/start`, `/stop`, `/hail` in a shared server
 * (Discord namespaces commands per application, but the picker stays unambiguous
 * this way). Consumed by `register-commands.js`; the runtime Lambda dispatches by
 * subcommand name in `lib/lambdas/commands.ts`.
 */

// Discord application command option types
// https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type
const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;

// The top-level command name + game label come from the active GameProfile
// (commandName, e.g. 'gate' / 'hugin'). Read from the compiled profile so this
// hand-written schema stays in sync with the TS source; falls back to the
// abiotic-factor defaults if the build isn't present (run `npm run build` first).
function activeGame() {
  try {
    return require('../dist/lib/games').ACTIVE_GAME;
  } catch (e) {
    return { commandName: process.env.GATE_COMMAND_NAME || 'gate', displayName: 'Abiotic Factor' };
  }
}
const GAME = activeGame();

// `/<cmd> notify set` category choices: the fixed lifecycle categories plus one
// per distinct event category the active game defines (deaths, raids, …). Kept in
// sync with notifyCategories() in lib/lambdas/utils/aws-clients.ts.
const NOTIFY_CHOICES = (() => {
  const seen = new Map([
    ['online', 'Server online / ready'],
    ['idle', 'Idle-shutdown notice'],
    ['backup', 'Backup complete'],
    ['failed', 'Failed to start'],
  ]);
  for (const e of (GAME.events || [])) {
    const cat = e.category || e.id;
    if (!seen.has(cat)) seen.set(cat, e.label || cat);
  }
  return [...seen].map(([value, name]) => ({ name, value }));
})();

const DISCORD_COMMANDS = [
  {
    name: GAME.commandName,
    description: `Manage the ${GAME.displayName} server`,
    options: [
      {
        type: SUB_COMMAND,
        name: 'hail',
        description: 'A word from Director Manse (ping test)',
      },
      {
        type: SUB_COMMAND,
        name: 'start',
        description: 'Start the server',
        options: [
          {
            type: STRING,
            name: 'world',
            description: "World to load (defaults to this server's configured default)",
            required: false,
          },
          {
            type: BOOLEAN,
            name: 'private',
            description: 'Quiet session: no public announcement; friends join via /join. Open later with /open.',
            required: false,
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'stop',
        description: 'Stop the server (backs up first)',
        options: [
          {
            type: BOOLEAN,
            name: 'force',
            description: 'Skip backup and stop immediately',
            required: false,
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'status',
        description: 'Check the server status and player count',
      },
      {
        type: SUB_COMMAND,
        name: 'backup',
        description: 'Back up the world now without stopping the server',
      },
      {
        type: SUB_COMMAND,
        name: 'open',
        description: 'Open a private session to the channel (announce join details to everyone)',
      },
      {
        type: SUB_COMMAND,
        name: 'join',
        description: 'Get the address to connect to the server',
      },
      {
        type: SUB_COMMAND,
        name: 'worlds',
        description: 'List the worlds this Discord server can start',
      },
      {
        type: SUB_COMMAND,
        name: 'mods',
        description: "A world's mod list (install these to join modded worlds)",
        options: [
          {
            type: STRING,
            name: 'world',
            description: "World to inspect (defaults to this server's default world)",
            required: false,
          },
        ],
      },
      {
        type: SUB_COMMAND_GROUP,
        name: 'schedule',
        description: 'Schedule a server opening',
        options: [
          {
            type: SUB_COMMAND,
            name: 'set',
            description: 'Schedule the next opening (pre-warms so it is joinable on time)',
            options: [
              {
                type: STRING,
                name: 'when',
                description: 'e.g. 20:00 · fri 19:30 · 2026-06-13 18:00 (server timezone)',
                required: true,
              },
              {
                type: STRING,
                name: 'world',
                description: "World to load (defaults to this server's configured default)",
                required: false,
              },
            ],
          },
          {
            type: SUB_COMMAND,
            name: 'clear',
            description: 'Cancel the scheduled opening',
          },
          {
            type: SUB_COMMAND,
            name: 'list',
            description: 'Show the scheduled opening',
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'setup',
        description: 'Configure GATEKeeper notifications for this channel',
      },
      {
        type: SUB_COMMAND_GROUP,
        name: 'notify',
        description: 'Turn server notifications on or off',
        options: [
          {
            type: SUB_COMMAND,
            name: 'set',
            description: 'Enable or silence a notification category',
            options: [
              {
                type: STRING,
                name: 'category',
                description: 'Which notifications to change',
                required: true,
                choices: NOTIFY_CHOICES,
              },
              {
                type: STRING,
                name: 'state',
                description: 'on or off',
                required: true,
                choices: [
                  { name: 'on', value: 'on' },
                  { name: 'off', value: 'off' },
                ],
              },
            ],
          },
          {
            type: SUB_COMMAND,
            name: 'list',
            description: 'Show all notification settings',
          },
        ],
      },
      {
        // Owner-only at runtime (BOT_OWNER_IDS) — the handler gates it; this is
        // just the schema. Tunes the cost-guardrail timers the monitor enforces.
        type: SUB_COMMAND_GROUP,
        name: 'config',
        description: 'Owner-only: tune the cost-guardrail timers',
        options: [
          {
            type: SUB_COMMAND,
            name: 'show',
            description: 'Show the idle auto-shutdown and boot-timeout windows',
          },
          {
            type: SUB_COMMAND,
            name: 'set',
            description: 'Set a cost-guardrail timer (minutes)',
            options: [
              {
                type: STRING,
                name: 'key',
                description: 'Which timer to set',
                required: true,
                choices: [
                  { name: 'Idle auto-shutdown', value: 'auto-shutdown' },
                  { name: 'Boot timeout', value: 'boot-timeout' },
                ],
              },
              {
                type: INTEGER,
                name: 'minutes',
                description: 'Minutes (to disable a guard, use the CLI)',
                required: true,
                min_value: 1,
              },
            ],
          },
        ],
      },
      {
        type: SUB_COMMAND,
        name: 'help',
        description: 'Show GATEKeeper help',
      },
    ],
  },
];

async function getRegisteredCommands(appId, botToken) {
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;
  const response = await fetch(url, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function compareCommands(local, registered) {
  const localNames = local.map((c) => c.name);
  const registeredNames = registered.map((c) => c.name);
  const matching = localNames.filter((n) => registeredNames.includes(n));
  const missing = localNames.filter((n) => !registeredNames.includes(n));
  const extra = registeredNames.filter((n) => !localNames.includes(n));
  return {
    local,
    registered,
    matching,
    missing,
    extra,
    inSync: missing.length === 0 && extra.length === 0,
  };
}

module.exports = { DISCORD_COMMANDS, getRegisteredCommands, compareCommands };
