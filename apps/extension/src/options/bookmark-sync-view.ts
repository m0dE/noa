/** Settings > Account: the bookmark sync switch's note (Noa Browser only). Pure. */

export const BOOKMARK_SYNC_HINT = "Your bookmarks on every computer where you use Noa Browser with this account.";

/** The note under the switch: what it does, when it last synced, or why it did not. */
export function bookmarkSyncNote(on: boolean, stored: { lastSyncAt?: string; lastError?: string } | undefined, now = Date.now()): string {
  if (!on) return BOOKMARK_SYNC_HINT;
  if (stored?.lastError) return `Not synced: ${stored.lastError}`;
  if (!stored?.lastSyncAt) return "Syncing…";
  const minutes = Math.round((now - Date.parse(stored.lastSyncAt)) / 60_000);
  return minutes < 1 ? "Synced just now." : minutes < 60 ? `Synced ${minutes} min ago.` : `Synced ${new Date(stored.lastSyncAt).toLocaleString()}.`;
}
