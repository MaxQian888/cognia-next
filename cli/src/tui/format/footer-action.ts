/**
 * Map a clicked status-footer segment to the slash command it should run.
 *
 * Four segments have bespoke in-App handlers that open a picker or mutate state
 * directly (model/provider → model overlay, mode → cycle permission, thinking →
 * effort slider), so they return null here. The rest become a quick shortcut to
 * the matching report/command — clicking the context gauge opens `/context`,
 * the git branch opens the `/diff` viewer, the cwd opens `/cwd`, and any of the
 * usage-derived numbers (tokens/cost/cache/ratelimit) open `/usage`. Pure →
 * unit-tested without a terminal.
 */
import type { StatusSegment } from "../../config/schema"

/** The slash command a click on footer segment `id` runs, or null when the
 * segment is handled inline by the App (model/provider/mode/thinking). */
export function footerSegmentCommand(id: StatusSegment): string | null {
  switch (id) {
    case "cwd":
      return "/cwd"
    case "ctx":
      return "/context"
    case "git":
      return "/diff"
    case "tokens":
    case "cost":
    case "cache":
    case "ratelimit":
      return "/usage"
    case "model":
    case "provider":
    case "mode":
    case "thinking":
      return null
  }
}
