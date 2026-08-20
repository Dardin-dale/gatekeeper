import { GAME_PROFILES, runtimeProfile } from '../../lib/games';
import { abioticFactor } from '../../lib/games/abiotic-factor';
import { BootPhase } from '../../lib/games/types';

/**
 * Boot-phase patterns are scraped from container logs by scripts/game/monitor.sh,
 * so a typo'd ERE fails silently in production: the phase simply never matches and
 * players are back to a blank "Starting…". These fixtures are VERBATIM lines from a
 * real Abiotic Factor boot (2026-08-10) — the same session where a failed game
 * update left the server on a stale build and nothing surfaced it for 45 minutes.
 *
 * Scope note: this pins the PATTERNS. The resolution rule that consumes them
 * (failure wins outright, else last match) lives in bash and is exercised by the
 * local-Docker tier; `resolve()` below mirrors it only to assert the ordering the
 * profile relies on, and must be kept in step with detect_boot_phase().
 */
const AF_LOG = {
  steamcmdSelfUpdate: '[  7%] Downloading update (6837 of 40321 KB)...',
  downloading: ' Update state (0x61) downloading, progress: 42.39 (1278121971 / 3014954555)',
  verifying: '[----] Verifying installation...',
  installed: "Success! App '2857200' fully installed.",
  mountingPak: 'LogPakFile: Display: Mounting pak file ../../../AbioticFactor/Content/Paks/pakchunk0-WindowsServer.pak.',
  worldCheck: 'LogAbiotic: Display: Dedicated Server entered ServerEntry, checking world save for corruption',
  loadingMap: 'LogAbiotic: Display: Dedicated Server is now loading the main map',
  sessionCode: 'LogAbiotic: Warning: Session short code: CASPT',
  updateFailed: "Error! App '2857200' state is 0x6 after update job.",
  installFailed: "ERROR! Failed to install app '2857200' (Missing configuration)",
  accessDenied:
    "CDepotDownloadMgr::BYldRequestDepotManifest(App: 2857200, Depot: 2857201, Manifest: 2231203230929773799, branch: ): Failed to get manifest request code, 'Access Denied'",
};

const phases = () => abioticFactor.bootPhases as BootPhase[];
const byId = (id: string) => phases().find((p) => p.id === id)!;
const matches = (p: BootPhase, line: string) => new RegExp(p.pattern).test(line);

/** Mirror of detect_boot_phase(): failure wins outright, else the last match. */
function resolve(log: string[]): BootPhase | undefined {
  let winner: BootPhase | undefined;
  for (const p of phases()) {
    if (!log.some((l) => matches(p, l))) continue;
    winner = p;
    if (p.failure) break;
  }
  return winner;
}

describe('abiotic factor boot phases', () => {
  it('each phase matches its real log line', () => {
    expect(matches(byId('steamcmd'), AF_LOG.steamcmdSelfUpdate)).toBe(true);
    expect(matches(byId('downloading'), AF_LOG.downloading)).toBe(true);
    expect(matches(byId('verifying'), AF_LOG.verifying)).toBe(true);
    expect(matches(byId('launching'), AF_LOG.installed)).toBe(true);
    expect(matches(byId('launching'), AF_LOG.mountingPak)).toBe(true);
    expect(matches(byId('world-check'), AF_LOG.worldCheck)).toBe(true);
    expect(matches(byId('loading-map'), AF_LOG.loadingMap)).toBe(true);
    expect(matches(byId('registering'), AF_LOG.sessionCode)).toBe(true);
  });

  it('recognises every observed update failure', () => {
    const failed = byId('update-failed');
    expect(matches(failed, AF_LOG.updateFailed)).toBe(true);
    expect(matches(failed, AF_LOG.installFailed)).toBe(true);
    expect(matches(failed, AF_LOG.accessDenied)).toBe(true);
    expect(failed.failure).toBe(true);
  });

  it("does not mistake SteamCMD's own self-update for the game download", () => {
    // Both are "downloading"; only the game's carries an `Update state` prefix.
    expect(matches(byId('downloading'), AF_LOG.steamcmdSelfUpdate)).toBe(false);
    expect(matches(byId('steamcmd'), AF_LOG.downloading)).toBe(false);
  });

  it('extracts download progress as a number', () => {
    const p = byId('downloading');
    const m = AF_LOG.downloading.match(new RegExp(p.progressPattern!));
    expect(m).not.toBeNull();
    expect(parseFloat(m![1])).toBeCloseTo(42.39);
  });

  it('advances to the furthest stage reached during a healthy boot', () => {
    expect(
      resolve([AF_LOG.steamcmdSelfUpdate, AF_LOG.downloading, AF_LOG.installed, AF_LOG.loadingMap])?.id,
    ).toBe('loading-map');
  });

  it('reports a failed update even though the stale build keeps booting past it', () => {
    // The exact 2026-08-10 shape: the update failed, yet the server went on to
    // load the map and print a session code. Reporting "Loading the facility"
    // there would hide the only fact that matters — no client can connect.
    const phase = resolve([
      AF_LOG.steamcmdSelfUpdate,
      AF_LOG.updateFailed,
      AF_LOG.mountingPak,
      AF_LOG.worldCheck,
      AF_LOG.loadingMap,
      AF_LOG.sessionCode,
    ]);
    expect(phase?.id).toBe('update-failed');
    expect(phase?.failure).toBe(true);
  });

  it('reports nothing before the container has logged anything', () => {
    expect(resolve([])).toBeUndefined();
  });

  it('ships bootPhases to the host in the runtime profile', () => {
    const rt = runtimeProfile(abioticFactor) as { bootPhases: BootPhase[] };
    expect(rt.bootPhases.length).toBe(abioticFactor.bootPhases!.length);
    expect(rt.bootPhases.some((p) => p.failure)).toBe(true);
  });

  it('every profile with bootPhases keeps ids unique and patterns valid', () => {
    for (const p of Object.values(GAME_PROFILES)) {
      const bp = p.bootPhases ?? [];
      expect(new Set(bp.map((b) => b.id)).size).toBe(bp.length);
      for (const b of bp) {
        expect(() => new RegExp(b.pattern)).not.toThrow();
        expect(b.label).toBeTruthy();
        if (b.progressPattern) expect(() => new RegExp(b.progressPattern!)).not.toThrow();
      }
    }
  });
});
