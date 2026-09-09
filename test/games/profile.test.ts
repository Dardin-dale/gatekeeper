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

describe('admin list', () => {
  it('every profile makes adminIds apply somewhere: an env var or a rendered file', () => {
    for (const p of Object.values(GAME_PROFILES)) {
      const viaEnv = Boolean(p.container.envMap.adminIds);
      const viaFile = Boolean(p.container.adminFile);
      expect(viaEnv || viaFile).toBe(true);
      if (viaFile) {
        // Relative to the data volume root, and templated per id.
        expect(p.container.adminFile!.path.startsWith('/')).toBe(false);
        expect(p.container.adminFile!.line).toContain('{id}');
      }
    }
  });

  it('abiotic factor renders Admin.ini ([Moderators] / Moderator=<SteamID64>) — its image has no admin env', () => {
    expect(abioticFactor.container.envMap.adminIds).toBeUndefined();
    expect(abioticFactor.container.adminFile).toEqual({
      path: 'SaveGames/Server/Admin.ini',
      header: '[Moderators]',
      line: 'Moderator={id}',
    });
  });

  it('valheim keeps the env-var route and declares no admin file', () => {
    expect(valheim.container.envMap.adminIds).toBe('ADMINLIST_IDS');
    expect(valheim.container.adminFile).toBeUndefined();
  });

  it('runtimeProfile emits adminFile for the host (null when the game has none)', () => {
    expect(runtimeProfile(abioticFactor).adminFile).toEqual(abioticFactor.container.adminFile);
    expect(runtimeProfile(valheim).adminFile).toBeNull();
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

describe('volumes', () => {
  it('the data root (last mount) is never a seeded image dir', () => {
    // Backup/restore/adminFile all key off volumes[-1] as the data root; a
    // seeded cache there would land in every S3 tar.
    for (const p of Object.values(GAME_PROFILES)) {
      const last = p.container.volumes[p.container.volumes.length - 1];
      expect({ game: p.id, seeded: last.seedFromImage ?? false }).toEqual({ game: p.id, seeded: false });
      expect(last.hostPath.startsWith('/mnt/game-data/')).toBe(true);
    }
  });

  it('valheim persists SteamCMD (seeded from the image) and the server install outside the data root', () => {
    const v = valheim.container.volumes;
    expect(v[v.length - 1]).toEqual({ hostPath: '/mnt/game-data/config', containerPath: '/config' });
    expect(v.find((m) => m.containerPath === '/opt/steamcmd')).toMatchObject({
      hostPath: '/mnt/game-data/steamcmd',
      seedFromImage: true,
    });
    expect(v.find((m) => m.containerPath === '/opt/valheim')?.seedFromImage).toBeUndefined();
    // runtimeProfile passes the flag through untouched for start-server.sh's jq.
    expect(runtimeProfile(valheim).volumes).toBe(v);
  });

  it("valheim hides the image's stale SteamCMD app-info cache behind an empty tmpfs (the Missing-configuration fix)", () => {
    expect(valheim.container.tmpfs).toEqual(['/home/valheim/Steam/appcache']);
    expect(runtimeProfile(valheim).tmpfs).toEqual(['/home/valheim/Steam/appcache']);
    expect(runtimeProfile(abioticFactor).tmpfs).toEqual([]);
  });

  describe('patch-day update self-heal (container.updateRepair)', () => {
    // Verbatim from the 1.0-day container log (2026-09-09 15:00:15 UTC): the
    // image's updater giving up on the delta update and serving the old build.
    const FALLBACK_LINE =
      'Sep  9 15:00:15 supervisord: valheim-updater ERROR - Failed to update Valheim server from Steam - however an existing version was found locally - using it';
    // The neighbouring lines that must NOT count as a fallback.
    const NOT_FALLBACK = [
      "Sep  9 15:00:15 supervisord: valheim-updater Error! App '896660' state is 0x6 after update job.",
      'Sep  9 15:00:15 supervisord: valheim-updater INFO - Valheim Server is already the latest version',
      'Sep  9 15:46:45 supervisord: valheim-updater INFO - Valheim Server was updated - restarting',
    ];

    it('valheim matches the "using the existing version" line and nothing near it', () => {
      const re = new RegExp(valheim.container.updateRepair!.pattern);
      expect(re.test(FALLBACK_LINE)).toBe(true);
      for (const l of NOT_FALLBACK) expect(re.test(l)).toBe(false);
    });

    it("valheim moves aside only SteamCMD's bookkeeping, never the game files, and re-pokes the updater", () => {
      const r = valheim.container.updateRepair!;
      expect(r.stalePaths).toEqual(['/opt/valheim/dl/server/steamapps']);
      expect(r.retrigger).toContain('kill -HUP');
    });

    it('every stale path sits under a declared volume so start-server.sh can clear it on the host', () => {
      for (const p of Object.values(GAME_PROFILES)) {
        for (const stale of p.container.updateRepair?.stalePaths ?? []) {
          const mount = p.container.volumes.find(
            (v) => stale === v.containerPath || stale.startsWith(v.containerPath + '/'),
          );
          expect(mount).toBeDefined();
          // ...and outside the data root (the LAST volume), so the S3 backup never tars it.
          expect(mount).not.toBe(p.container.volumes[p.container.volumes.length - 1]);
        }
      }
    });

    it('rides game-profile.json as updateRepair (null when a game has no known repair)', () => {
      expect(runtimeProfile(valheim).updateRepair).toEqual(valheim.container.updateRepair);
      expect(runtimeProfile(abioticFactor).updateRepair).toBeNull();
    });
  });
});

describe('boot phases', () => {
  it('every failure phase says what fixes it (hint), since the generic advice differs per game', () => {
    for (const p of Object.values(GAME_PROFILES)) {
      for (const phase of p.bootPhases ?? []) {
        if (!phase.failure) continue;
        expect({ game: p.id, phase: phase.id, hint: phase.hint }).toMatchObject({
          hint: expect.stringMatching(/\S/),
        });
      }
    }
  });

  it("valheim's update-failed hint does not send people to Restart as the first move", () => {
    const failed = valheim.bootPhases!.find((b) => b.id === 'update-failed')!;
    expect(failed.hint).toMatch(/quarter-hour/);
    expect(failed.hint!.indexOf('retries the update on its own')).toBeLessThan(failed.hint!.indexOf('Restart'));
  });
});
