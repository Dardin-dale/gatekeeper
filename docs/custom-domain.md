# Custom Domain (optional)

GATEKeeper gives each game a stable address derived from one shared base domain, so players connect
to a name instead of a changing public IP.

## How it works

- Set **`BASE_DOMAIN`** in `.env` (e.g. `BASE_DOMAIN=gjurdsihop.net`). That's the only setting.
- Each game derives `<subdomain>.<BASE_DOMAIN>` from its profile's `subdomain` field — e.g. Abiotic
  Factor → `abiotic.gjurdsihop.net`, Valheim → `valheim.gjurdsihop.net`. One hosted zone, one record
  per game, no per-game env.
- On deploy, if `BASE_DOMAIN` is set, the stack creates a Lambda that **upserts the A record** to the
  instance's public IP every time it reaches the `running` state (TTL 60s). The `CustomDomain` stack
  output shows `<domain>:<gamePort>`.
- The on-host monitor's readiness ping and `/gate join` both prefer this domain (falling back to the
  public IP when `BASE_DOMAIN` is unset).

## Prerequisites

1. A domain whose DNS is hosted in **Route 53** (a public hosted zone for the apex, e.g.
   `gjurdsihop.net`). The updater finds the zone by name and only needs `route53:ChangeResourceRecordSets`.
2. `BASE_DOMAIN` set before `npm run deploy` (it's read at synth).

## Without a custom domain

Leave `BASE_DOMAIN` unset. No Route 53 infra is created; the bot reports the instance's public IP in
the readiness ping and `/gate status`, and `/gate join` tells players to use that IP.

## Per-game subdomain

Change a game's label by editing `subdomain` in its `lib/games/<game>.ts` profile. It defaults to the
game `id` when omitted.
