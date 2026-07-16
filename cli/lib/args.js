'use strict';
// Minimal flag parser shared by CLI commands: `--flag=value` sets a string value,
// bare `--flag` sets boolean true, and everything else is positional. Flag names
// are lowercase letters (the convention across cli/commands/*).
function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (const arg of rest) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(arg);
  }
  return { flags, positional };
}

module.exports = { parseFlags };
