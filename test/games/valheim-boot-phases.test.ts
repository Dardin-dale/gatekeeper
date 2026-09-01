import { valheim } from '../../lib/games/valheim';
import { BootPhase } from '../../lib/games/types';

/**
 * Verbatim lines from the 2026-08-20 Valheim boot — the one that wedged when
 * SteamCMD self-updated, restarted mid-command, lost its install dir, and left
 * the server unlaunched for 13 minutes with nothing in Discord to show for it.
 */
const LOG = {
  backup: 'supervisord: valheim-backup   adding: config/worlds_local/GjurdsIHOP.fwl',
  // Thousands-separated, unlike Abiotic Factor's plain digits — same binary, different formatting.
  steamcmd: 'supervisord: valheim-updater [ 86%] Downloading update (36,155 of 40,321 KB)...',
  downloading: 'supervisord: valheim-updater  Update state (0x61) downloading, progress: 6.13 (107703544 / 1756871901)',
  verifying: 'supervisord: valheim-updater  Update state (0x5) verifying install, progress: 17.66 (310345815 / 1756871901)',
  mods: 'supervisord: valheim-updater DEBUG - [342] - BepInEx is enabled - running updater',
  connected: 'supervisord: valheim-server 08/20/2026 20:45:00: Game server connected',
  playfab: 'supervisord: valheim-server 08/20/2026 20:45:00: Opened PlayFab server',
  registering: 'supervisord: valheim-server 08/20/2026 20:45:00: Register PlayFab server "GjurdsIHOP" with IP 35.93.161.227:2456',
  joinCode: 'supervisord: valheim-server 08/20/2026 20:45:03: Session "GjurdsIHOP" registered with join code 528519',
  liveHeartbeat: 'supervisord: valheim-server 08/20/2026 20:45:05: Session "GjurdsIHOP" with join code 528519 and IP 35.93.161.227:2456 is active with 0 player(s)',
  // Vanilla (no -crossplay) boot, verbatim from a local docker run 2026-09-01:
  // Steam networking, no PlayFab session, no join code — A2S answers instead.
  vanillaLobby: 'supervisord: valheim-server 09/01/2026 18:57:54: Registering lobby',
  vanillaOpened: 'supervisord: valheim-server 09/01/2026 18:57:54: Opened Steam server',
  installFailed: "supervisord: valheim-updater ERROR! Failed to install app '896660' (Missing configuration)",
  downloadFailed: 'supervisord: valheim-updater ERROR - Failed to download Valheim server from Steam - retrying later',
};

const phases = () => valheim.bootPhases as BootPhase[];
const byId = (id: string) => phases().find((p) => p.id === id)!;
const hits = (p: BootPhase, line: string) => new RegExp(p.pattern).test(line);

/** Mirror of detect_boot_phase(): failure wins outright, else the last match. */
function resolve(log: string[]): BootPhase | undefined {
  let winner: BootPhase | undefined;
  for (const p of phases()) {
    if (!log.some((l) => hits(p, l))) continue;
    winner = p;
    if (p.failure) break;
  }
  return winner;
}

describe('valheim boot phases', () => {
  it('each phase matches its real log line', () => {
    expect(hits(byId('backup'), LOG.backup)).toBe(true);
    expect(hits(byId('steamcmd'), LOG.steamcmd)).toBe(true);
    expect(hits(byId('downloading'), LOG.downloading)).toBe(true);
    expect(hits(byId('verifying'), LOG.verifying)).toBe(true);
    expect(hits(byId('mods'), LOG.mods)).toBe(true);
    expect(hits(byId('loading'), LOG.connected)).toBe(true);
    expect(hits(byId('loading'), LOG.playfab)).toBe(true);
    expect(hits(byId('registering'), LOG.registering)).toBe(true);
    expect(hits(byId('registering'), LOG.joinCode)).toBe(true);
  });

  it('a vanilla (non-crossplay) boot reaches "registering" via the Steam lobby lines', () => {
    expect(hits(byId('registering'), LOG.vanillaLobby)).toBe(true);
    expect(hits(byId('registering'), LOG.vanillaOpened)).toBe(true);
    // ...and never through a PlayFab-only line.
    expect(hits(byId('loading'), LOG.vanillaOpened)).toBe(false);
    expect(resolve([LOG.connected, LOG.vanillaLobby, LOG.vanillaOpened])?.id).toBe('registering');
  });

  it("matches SteamCMD's thousands-separated counter", () => {
    // The Abiotic Factor pattern was plain-digit only and would have missed this.
    expect(hits(byId('steamcmd'), LOG.steamcmd)).toBe(true);
    expect(hits(byId('steamcmd'), 'Downloading update (6837 of 40321 KB)...')).toBe(true);
  });

  it('recognises both halves of the 2026-08-20 wedge', () => {
    const failed = byId('update-failed');
    expect(hits(failed, LOG.installFailed)).toBe(true);
    expect(hits(failed, LOG.downloadFailed)).toBe(true);
    expect(failed.failure).toBe(true);
  });

  it('reports the wedge instead of the stage it reached before dying', () => {
    // Exactly what happened: backup ran, SteamCMD self-updated, then it died.
    // Reporting "Updating SteamCMD" there would read as healthy progress.
    const phase = resolve([LOG.backup, LOG.steamcmd, LOG.installFailed, LOG.downloadFailed]);
    expect(phase?.id).toBe('update-failed');
  });

  it('prefers the closest-to-joinable stage when updater and server overlap', () => {
    // The server connected to PlayFab at 20:45:00 while the updater was still
    // verifying at 20:45:14 — ordering must not report it as going backwards.
    expect(resolve([LOG.connected, LOG.verifying, LOG.registering])?.id).toBe('registering');
  });

  it('extracts progress from both download and verify lines', () => {
    for (const [id, line, want] of [
      ['downloading', LOG.downloading, 6.13],
      ['verifying', LOG.verifying, 17.66],
    ] as const) {
      const m = line.match(new RegExp(byId(id).progressPattern!));
      expect(parseFloat(m![1])).toBeCloseTo(want);
    }
  });

  it('does not fire the failure phase on a healthy boot', () => {
    expect(resolve([LOG.backup, LOG.downloading, LOG.mods, LOG.connected, LOG.joinCode])?.failure).toBeFalsy();
  });

  it('leaves the liveness heartbeat to livenessLogPattern, not a phase', () => {
    // Liveness is the monitor's own signal; a phase matching it would keep
    // publishing "registering" into a session that is already live.
    expect(new RegExp(valheim.livenessLogPattern!).test(LOG.liveHeartbeat)).toBe(true);
  });
});
