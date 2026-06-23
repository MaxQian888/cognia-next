/**
 * A single monotonic counter shared by the two independent navigation intents
 * that can race in the desktop shell: selecting a guild (`useUIStore`) and
 * selecting a chat session (`useChatStore`). Each setter stamps its slice with
 * the next epoch, so a consumer can compare the two stamps to learn which the
 * user touched most recently and let that one win.
 *
 * Session-local by design — never persisted. Ordering only matters within a
 * single run; the counter resets to 0 on reload, which is fine because both
 * stamps reset together.
 */
let counter = 0

/** Return the next navigation epoch (strictly increasing within a run). */
export function nextNavEpoch(): number {
  counter += 1
  return counter
}
