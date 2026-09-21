/**
 * The 79 P0 acceptance cases (`contracts/spec/acceptance.yaml`) mapped to the
 * batch that owns them (ADR-0188). A test whose title carries `[ACC:<ID>]` is
 * the executable evidence for that case; `registry.test.ts` fails when a
 * delivered batch has a case with no tagged test anywhere in the repository, or
 * when this table drifts from the YAML.
 *
 * Several cases translate a server-side mechanism onto this stack (the ADR
 * records each): RLS → key-scope and actor isolation (AUTH-03, CACHE-05),
 * Redis loss → notification-channel loss with polling fallback (REC-07).
 */

export type AcceptanceBatch = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7"

export const ACCEPTANCE_BATCH: Record<string, AcceptanceBatch> = {
  "AUTH-01": "B2",
  "AUTH-02": "B2",
  "AUTH-03": "B2",
  "AUTH-04": "B1",
  "AUTH-05": "B3",
  "AUTH-06": "B1",
  "AUTH-07": "B1",
  "API-01": "B2",
  "API-02": "B1",
  "API-03": "B1",
  "API-04": "B1",
  "API-05": "B1",
  "API-06": "B2",
  "API-07": "B1",
  "API-08": "B4",
  "ROUTE-01": "B1",
  "ROUTE-02": "B1",
  "ROUTE-03": "B5",
  "ROUTE-04": "B1",
  "ROUTE-05": "B1",
  "ROUTE-06": "B1",
  "ROUTE-07": "B1",
  "ROUTE-08": "B1",
  "BUD-01": "B1",
  "BUD-02": "B3",
  "BUD-03": "B1",
  "BUD-04": "B1",
  "BUD-05": "B1",
  "BUD-06": "B1",
  "BUD-07": "B1",
  "BUD-08": "B1",
  "BUD-09": "B1",
  "BUD-10": "B1",
  "BUD-11": "B1",
  "BUD-12": "B1",
  "REC-01": "B1",
  "REC-02": "B1",
  "REC-03": "B3",
  "REC-04": "B1",
  "REC-05": "B1",
  "REC-06": "B4",
  "REC-07": "B2",
  "CAS-01": "B3",
  "CAS-02": "B3",
  "CAS-03": "B3",
  "CAS-04": "B3",
  "PAN-01": "B3",
  "PAN-02": "B3",
  "PAN-03": "B3",
  "PAN-04": "B3",
  "PAN-05": "B3",
  "PAN-06": "B3",
  "PAN-07": "B3",
  "PAN-08": "B3",
  "DEL-01": "B4",
  "DEL-02": "B4",
  "DEL-03": "B4",
  "DEL-04": "B4",
  "DEL-05": "B4",
  "DEL-06": "B4",
  "DEL-07": "B4",
  "CACHE-01": "B1",
  "CACHE-02": "B3",
  "CACHE-03": "B1",
  "CACHE-04": "B1",
  "CACHE-05": "B2",
  "SSE-01": "B2",
  "SSE-02": "B3",
  "SSE-03": "B2",
  "SSE-04": "B2",
  "EVAL-01": "B6",
  "EVAL-02": "B6",
  "EVAL-03": "B6",
  "EVAL-04": "B6",
  "CFG-01": "B1",
  "CFG-02": "B1",
  "SAFE-01": "B3",
  "SAFE-02": "B4",
  "PROF-01": "B1",
}

/**
 * Cognia-specific cases added by ADR-0188 on top of the spec: the opt-in
 * guarantees (D36/D37 — off means untouched) and fault isolation (D38/D39).
 */
export const COGNIA_ACCEPTANCE_BATCH: Record<string, AcceptanceBatch> = {
  /** Every switch defaults off. */
  "OFF-01": "B1",
  /** With switches off the send path's output is identical to the pre-feature baseline. */
  "OFF-02": "B1",
  /** With switches off no router-fusion module loads and the fusion DB is never opened. */
  "OFF-03": "B1",
  /** With switches off the sidecar dispatch is unchanged (no gate, default retries, fallbackModel intact). */
  "OFF-04": "B1",
  /** An infrastructure fault on ordinary traffic falls back to the original path with a visible notice. */
  "ISO-01": "B1",
  /** Consecutive faults trip the surface breaker; re-arming restores it. */
  "ISO-02": "B1",
  /**
   * Explicitly chosen fusion work fails explicitly on an infrastructure fault.
   * B2: the first explicit surface is the Run API; B1's only surface, chat, is
   * ordinary traffic.
   */
  "ISO-03": "B2",
  /** A budget or limit refusal is not treated as an infrastructure fault. */
  "ISO-04": "B1",
  /** Cross-database outbox replay is idempotent: one assistant answer after any crash window. */
  "ISO-05": "B1",
  /**
   * INV-09: a fusion run never nests under a fusion ancestor. The guard lives in
   * the explicit-run gate and ships with B3's explicit modes; B5's agent, Squad
   * and workflow surfaces are the places that would otherwise recurse, so they
   * add evidence for the same invariant rather than a new case.
   */
  "INV-09": "B3",
}

/**
 * Batches whose cases must all have tagged tests. Extended only when a batch
 * is complete — this is the gate that keeps "delivered" honest.
 */
export const DELIVERED_BATCHES: readonly AcceptanceBatch[] = ["B1", "B2", "B3"]

/** Roots scanned for `[ACC:<ID>]` test titles. */
export const ACCEPTANCE_TEST_ROOTS = [
  "packages/router-fusion/src",
  "packages/eval-core/src",
  "lib/router-fusion",
  "components/router-fusion",
  // Router + Fusion's seams in shared modules: the send path, the chat event
  // handler, routing fallback, durable replay, usage and the settings UI.
  "lib/claude",
  "lib/chat",
  "lib/db",
  "lib/work-submission",
  "hooks/chat",
  "components/chat",
  "components/providers/initializers",
  "components/settings/provider/routing",
  "crates/cognia-gateway",
  // The delegate sandbox and workspace tiers: DEL-04, DEL-05 and SAFE-02 are
  // proven in Rust, not in Jest.
  "crates/cognia-task-workspace",
  "crates/cognia-sandbox-runner",
  "crates/cognia-automation",
  "sidecar/dispatch",
  "tests/e2e",
] as const

export const ACCEPTANCE_TAG = /\[ACC:([A-Z]+-\d{2})\]/g
