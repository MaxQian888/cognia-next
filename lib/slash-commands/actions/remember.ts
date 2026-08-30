// Action handler for the `/remember` slash command (autonomous long-term
// memory — explicit capture path).
//
//   /remember <text>   — deliberately store a durable fact about the user.
//
// The actual write (PII gate → consolidator → persist) lives in
// `lib/memory/write/remember-fact.ts`, shared with the composer's `#` prefix so
// the two capture surfaces cannot drift. This handler only maps the typed
// result onto user-facing copy.

import type { SlashContext } from "../builtin"
import type { SlashCommandResultBlock } from "../system-blocks"
import { rememberFact } from "@/lib/memory/write/remember-fact"

export interface RememberCommandResult {
  system?: string
  /**
   * Structured chip. Mutually exclusive with `system`: a successful capture is
   * a one-line confirmation, and the chip already reads
   * `/remember <fact> — Saved to <scope> memory`, so also pushing prose would
   * post two system messages for one action.
   */
  block?: SlashCommandResultBlock
  /** When true, the caller should open the Memory settings/panel. */
  openMemory?: boolean
}

export async function dispatchRememberCommand(
  ctx: SlashContext
): Promise<RememberCommandResult | null> {
  const text = (ctx.args ?? "").trim()
  if (!text) {
    return {
      system: "Usage: `/remember <fact>` — e.g. `/remember I always use pnpm`.",
    }
  }

  const result = await rememberFact({ text, sessionId: ctx.activeSessionId })
  if (result.ok) {
    return {
      block: {
        kind: "slash-result",
        commandId: "remember",
        args: text,
        summary: `Saved to ${result.scope} memory`,
      },
    }
  }

  switch (result.reason) {
    case "disabled":
      return {
        system: "Long-term memory is turned off. Enable it in Settings → Memory.",
        openMemory: true,
      }
    case "temporary":
      return { system: "Temporary mode is on — memory is paused, so nothing was saved." }
    case "pii":
      return {
        system:
          "That looks like it contains sensitive data (an email, key, or similar), so it was **not** saved to memory.",
      }
    case "denied":
      return {
        system:
          "This agent isn't allowed to write memory in that scope, so nothing was saved. Adjust its memory permissions in Settings.",
        openMemory: true,
      }
    case "unavailable":
      return { system: "Couldn't reach the memory store right now, please try again." }
    default:
      return { system: "Something went wrong saving that to memory." }
  }
}
