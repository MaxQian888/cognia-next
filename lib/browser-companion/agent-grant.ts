/**
 * The capability grant a Browser Companion agent conversation runs with
 * (ADR-0228 §6, ADR-0198).
 *
 * Instructions only. The browser tools are admitted at the plugin-manifest gate
 * in `lib/claude/build-options.ts` for a conversation bound to a paired
 * browser — not through `tools.add`, which joins an allow list and would narrow
 * a turn that had no allow list down to the browser tools alone.
 */
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"

/** What the model is told about where its browser tools act. */
export const BROWSER_COMPANION_AGENT_INSTRUCTION =
  "This conversation was started from the user's own web browser through the Cognia browser " +
  "extension, with permission to act in that browser. The browser_* tools operate on the " +
  "user's real, signed-in tabs: the conversation's tabs are grouped under “Cognia”, and the " +
  "tab the user started from is the first one. Before acting on a site for the first time the " +
  "user is asked to allow it in the side panel; if a tool answers " +
  "browser_site_permission_required, ask the user to decide there rather than retrying. If a " +
  "tool answers browser_user_takeover, the user has taken control: stop acting and wait for " +
  "them. Never type into password or one-time-code fields; ask the user to do it. Prefer " +
  "browser_snapshot over screenshots, and keep actions to what the user asked for."

export function browserCompanionGrant(deviceId: string): AgentCapabilityGrantV1 {
  return {
    schemaVersion: 1,
    source: { kind: "browser-companion", id: deviceId },
    instructions: [BROWSER_COMPANION_AGENT_INSTRUCTION],
  }
}
