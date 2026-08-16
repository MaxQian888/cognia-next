/**
 * `/report` — open the unified "Report a problem" dialog from the composer.
 *
 * The dialog itself lives behind `useUIStore().pendingReportRequest` (rendered
 * by the root `ReportProblemHost`), so this handler only needs to raise the
 * request with what the composer knows: the surface and the active session,
 * which the report's `Support conversation` / diagnostics sections use for
 * scoping.
 */

import type { SlashContext } from "../builtin"

export async function runReportCommand(ctx: Pick<SlashContext, "activeSessionId">): Promise<void> {
  const { useUIStore } = await import("@/stores/ui")
  useUIStore.getState().requestReportProblem({
    surface: "chat",
    ...(ctx.activeSessionId ? { sessionId: ctx.activeSessionId } : {}),
  })
}
