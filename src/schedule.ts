/**
 * How often a scheduled sync may run, per mode.
 *
 * Inbox mode polls one small JSON endpoint, so a short interval costs almost nothing and an item
 * lands in the vault within seconds of the server packaging it. Mirror mode talks to a Git remote
 * every round — fetching that often would hammer someone else's server for nothing, so it keeps
 * the old minute. The timer ticks at the shorter interval and this decides whether the tick runs.
 */
export const TICK_MS = 10_000;
export const INBOX_INTERVAL_MS = 10_000;
export const MIRROR_INTERVAL_MS = 60_000;

export function intervalFor(mode: string | undefined): number {
  return mode === "inbox" ? INBOX_INTERVAL_MS : MIRROR_INTERVAL_MS;
}

/** Timers fire a little late; without the tolerance a 60s interval would only run every 70s. */
export function dueForScheduledSync(mode: string | undefined, lastAttemptAt: number, now: number): boolean {
  return now - lastAttemptAt + TICK_MS / 2 >= intervalFor(mode);
}
