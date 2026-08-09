/**
 * Tab activity badge — pure logic for tracking "new output since last viewed".
 *
 * When a terminal session receives data while its tab is not the active tab
 * for its project, `markActivity(id)` sets a flag. The flag is cleared by
 * `clearActivity(id)` when the user switches to that tab. The tab component
 * reads the flag to render a pulsing activity dot.
 *
 * Pure + stateless helpers only — the actual flag lives in the terminal store.
 */

/**
 * Whether a session should be marked with the activity badge given the
 * current state. A session has "new activity" when it has received data
 * AND it is not the currently-active tab for its project.
 */
export function shouldShowActivityBadge(
  sessionId: string,
  activeSessionId: string | null,
  hasActivity: boolean
): boolean {
  if (sessionId === activeSessionId) return false
  return hasActivity
}

/**
 * Whether incoming data on a session should flip the activity flag. Only
 * true when the session is NOT the active tab — data on the active tab is
 * already visible, so marking it as "new" would be redundant.
 */
export function shouldMarkActivity(sessionId: string, activeSessionId: string | null): boolean {
  return sessionId !== activeSessionId
}
