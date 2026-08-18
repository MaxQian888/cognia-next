import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { AgentPlan } from "@/types/agent/plan"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/**
 * Pull `AgentPlan` rows (`agentPlans`) from the desktop so the companion can
 * render the plan approval dock and the live step tracker (ADR-0045).
 *
 * Read-mostly mirror, exactly like `goals`: a plan is authored and executed on
 * the host, and the phone displays it. Without this handler the mobile /
 * companion shells mount `PlanApprovalDock` and `PlanTrackerDock` against an
 * empty local table — the UI exists, the row never arrives, and a plan-mode
 * turn taken through the companion dead-ends with nothing to approve.
 *
 * The event log (`agentPlanEvents`) deliberately stays host-side: it is an
 * append-only audit trail no companion surface reads, and mirroring it would
 * multiply sync volume for no rendered pixel.
 */
export function syncPlans(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<AgentPlan>(
    {
      table: "plans",
      getTable: () => getDb().agentPlans,
    },
    transport,
    cursor
  )
}
