import { runtimeProfile } from '../../lib/games';
import { valheim } from '../../lib/games/valheim';
import { abioticFactor } from '../../lib/games/abiotic-factor';
import { GameEvent } from '../../lib/games/types';

/**
 * Valheim logs "Player connection lost" for ANY dropped connection, so the raw
 * line announced a departure every time a player blipped out and reconnected
 * seconds later. confirmDrop holds the post one monitor cycle and lets the player
 * count arbitrate. These lines are real Valheim server output.
 */
const LEAVE_LINE = '10/03/2025 21:14:07: Player connection lost server 76561198073817655 now 2 player(s)';
const HEARTBEAT = '10/03/2025 21:14:20: Session "GjurdsIHOP" is active with 3 player(s)';

const leaveEvent = () => valheim.events!.find((e) => e.id === 'leave')!;

describe('valheim leave debounce', () => {
  it('still matches the real disconnect line', () => {
    expect(new RegExp(leaveEvent().pattern).test(LEAVE_LINE)).toBe(true);
  });

  it('is marked confirmDrop so a reconnect can cancel it', () => {
    expect(leaveEvent().confirmDrop).toBe(true);
  });

  it('does not fire on the liveness heartbeat', () => {
    expect(new RegExp(leaveEvent().pattern).test(HEARTBEAT)).toBe(false);
  });

  it('ships confirmDrop to the host in the runtime profile', () => {
    const rt = runtimeProfile(valheim) as { events: GameEvent[] };
    expect(rt.events.find((e) => e.id === 'leave')?.confirmDrop).toBe(true);
  });

  it('leaves join/death events immediate — only leaves need confirming', () => {
    for (const id of ['join', 'death']) {
      expect(valheim.events!.find((e) => e.id === id)?.confirmDrop).toBeFalsy();
    }
  });

  it("does not debounce Abiotic Factor's leave, which is an explicit exit", () => {
    // AF logs "has exited the facility" only on a deliberate disconnect, and its
    // count is derived from join/leave bookkeeping rather than a server-reported
    // number — so holding the post would delay flavor for no accuracy gain.
    for (const e of abioticFactor.events ?? []) expect(e.confirmDrop).toBeFalsy();
  });
});
