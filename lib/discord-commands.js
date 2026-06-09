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
const STRING = 3;
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
        name: 'join',
        description: 'Get the address to connect to the server',
      },
      {
        type: SUB_COMMAND,
        name: 'setup',
        description: 'Configure GATEKeeper notifications for this channel',
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
