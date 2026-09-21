/**
 * What the delegate surfaces show, derived from durable records only
 * (ADR-0188 B4, WP-D5).
 *
 * The rule this module exists to keep: a delegate review may only ever state
 * what the run's own records prove. The patch comes from `fusionPatchSets` and
 * its artifact, the checks from the `VerificationReport` the acceptance runner
 * produced, the counts from the run's journal, and the decisions from
 * `fusionAcceptanceApprovals`. Nothing is inferred from a model's text, and a
 * fact that is not recorded is rendered as "not recorded" rather than guessed
 * — which is why every count here is `number | null` and the sandbox tier is
 * the one the report ATTESTS, never the one the run asked for.
 *
 * Everything Router + Fusion is reached with a dynamic `import()` behind the
 * master switch (D36/D37): with Router + Fusion off this module loads nothing
 * and answers `{ state: "off" }`, so the cockpit is byte-for-byte what it was.
 *
 * The record shapes below are structural on purpose. `lib/router-fusion/db`
 * rows satisfy them, and keeping the UI to the fields it reads means a row
 * gaining a column never touches this file.
 */

export type DelegateApprovalKindView = "scope_expansion" | "workspace_apply"
export type DelegateApprovalStatusView = "pending" | "approved" | "denied"
export type DelegateDeliveryView = "patch_only" | "workspace_updated"
export type DelegateSandboxTierView = "microvm" | "container" | "os"
export type DelegateCheckStatusView = "passed" | "failed" | "inconclusive" | "not_applicable"

export const DELEGATE_SANDBOX_TIERS: readonly DelegateSandboxTierView[] = [
  "microvm",
  "container",
  "os",
]
export const DELEGATE_CHECK_STATUSES: readonly DelegateCheckStatusView[] = [
  "passed",
  "failed",
  "inconclusive",
  "not_applicable",
]
export const DELEGATE_VERIFICATION_LEVELS = [
  "schema_only",
  "model_review",
  "tool_verified",
  "human_review",
  "mixed",
] as const

// ── the records this module reads ────────────────────────────────────────────

export interface DelegateRunEventRecord {
  type: string
  payload: Record<string, unknown>
}

export interface DelegateRunRecord {
  runId: string
  mode: string
  status: string
  resultRecordArtifactId?: string | null
  workspaceRoot?: string | null
  projectId?: string | null
}

export interface DelegatePatchSetRecord {
  patchSetId: string
  runId: string
  baseRevision: string
  resultRevision: string | null
  patchSha256: string
  patchArtifactId: string
  fileCount: number
  paths: readonly string[]
  delivery: DelegateDeliveryView
  appliedRevision: string | null
  appliedAt: number | null
  createdAt: number
}

export interface DelegateApprovalRecord {
  id: string
  kind: DelegateApprovalKindView
  requestDigest: string
  revision: string
  status: DelegateApprovalStatusView
  summary: {
    paths: readonly string[]
    fileCount: number
    patchSha256: string | null
    patchArtifactId: string | null
  }
  createdAt: number
  decidedAt: number | null
}

/**
 * How one file of the patch compares with the workspace as it is on this
 * device. `absent` is a file the workspace does not have (the patch creates
 * it); `unavailable` is a read that did not happen, which the view states
 * rather than drawing an all-added diff without saying why.
 */
export type DelegateBaseRead =
  { state: "read"; content: string } | { state: "absent" } | { state: "unavailable" }

export interface DelegateWorkspaceComparison {
  /** The workspace revision the reads came from, or null when it is unknown. */
  revision: string | null
  read(path: string): Promise<DelegateBaseRead>
}

// ── the view models ──────────────────────────────────────────────────────────

export interface DelegatePatchFileView {
  path: string
  action: "write" | "delete"
  /** The patch's whole-file content; null for a delete. */
  newContent: string | null
  baseContent: string | null
  baseState: DelegateBaseRead["state"]
  /** True when the workspace already holds exactly this content. */
  unchanged: boolean
}

export interface DelegatePatchView {
  patchSetId: string
  baseRevision: string
  resultRevision: string | null
  patchSha256: string
  patchArtifactId: string
  fileCount: number
  paths: readonly string[]
  delivery: DelegateDeliveryView
  appliedRevision: string | null
  appliedAt: number | null
  /** The patch document as stored, for the download. Null once it expired. */
  document: string | null
  files: readonly DelegatePatchFileView[]
  /** The workspace revision the files were compared against, if any. */
  comparedRevision: string | null
  /** True when the comparison is against the patch's own base revision. */
  comparedAtBase: boolean
}

export interface DelegateCheckView {
  checkId: string
  kind: string
  status: DelegateCheckStatusView
  summary: string
  executedBy: "runtime" | "model" | "human"
}

export interface DelegateAcceptanceView {
  status: DelegateCheckStatusView
  level: string
  /** The revision the report is about; null when it names none. */
  revision: string | null
  verifierVersion: string
  /** The tier the runner attested. Null means "not attested", never "none". */
  tier: DelegateSandboxTierView | null
  exit: string | null
  report: string | null
  discovered: number | null
  passed: number | null
  failed: number | null
  errored: number | null
  skipped: number | null
  checks: readonly DelegateCheckView[]
  /** True when a check the report carries was produced by a model, not the runtime. */
  hasModelCheck: boolean
}

export interface DelegateProgressView {
  subtasks: number | null
  attempts: number
  turns: number
  toolOperations: number
  repairs: number
  takeovers: number
  scopeExpansions: number
  tier: DelegateSandboxTierView | null
  delivery: DelegateDeliveryView | null
  deliveredRevision: string | null
  /** Nothing in the journal named a delegate step. */
  empty: boolean
}

export interface DelegateApprovalView {
  id: string
  kind: DelegateApprovalKindView
  status: DelegateApprovalStatusView
  requestDigest: string
  revision: string
  paths: readonly string[]
  fileCount: number
  createdAt: number
  decidedAt: number | null
}

export interface DelegateReview {
  runId: string
  status: string
  patch: DelegatePatchView | null
  acceptance: DelegateAcceptanceView | null
  progress: DelegateProgressView
  approvals: readonly DelegateApprovalView[]
  pendingApproval: DelegateApprovalView | null
}

export type DelegateReviewState =
  | { state: "ready"; review: DelegateReview }
  /** Router + Fusion is switched off here: nothing was loaded. */
  | { state: "off" }
  /** The run exists but is not a delegate run, so there is nothing to review. */
  | { state: "not-delegate" }
  /** The record could not be read (fusion database, vault, artifact store). */
  | { state: "unavailable"; reason: string }

// ── derivations ──────────────────────────────────────────────────────────────

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function isTier(value: unknown): value is DelegateSandboxTierView {
  return typeof value === "string" && (DELEGATE_SANDBOX_TIERS as readonly string[]).includes(value)
}

function isCheckStatus(value: unknown): value is DelegateCheckStatusView {
  return typeof value === "string" && (DELEGATE_CHECK_STATUSES as readonly string[]).includes(value)
}

function isDelivery(value: unknown): value is DelegateDeliveryView {
  return value === "patch_only" || value === "workspace_updated"
}

const EMPTY_PROGRESS: DelegateProgressView = {
  subtasks: null,
  attempts: 0,
  turns: 0,
  toolOperations: 0,
  repairs: 0,
  takeovers: 0,
  scopeExpansions: 0,
  tier: null,
  delivery: null,
  deliveredRevision: null,
  empty: true,
}

/**
 * What the run's own journal says it did: subtasks planned, attempts started,
 * worker turns spent, tool operations, repairs and lead takeovers.
 *
 * Counted from `phase.changed` events with `phase: "delegate"`, which the
 * workflow emits as it goes (`workflows/delegate.ts`). A repair and a takeover
 * are attempts of their own `kind`, so they are counted where they happen
 * rather than read from a total that could have been written by anything.
 */
export function delegateProgressFrom(
  events: readonly DelegateRunEventRecord[]
): DelegateProgressView {
  let seen = false
  const progress: DelegateProgressView = { ...EMPTY_PROGRESS }
  for (const event of events) {
    if (event.type !== "phase.changed") continue
    const payload = event.payload ?? {}
    if (payload.phase !== "delegate") continue
    seen = true
    switch (payload.step) {
      case "planned":
        progress.subtasks = count(payload.subtasks)
        break
      case "attempt":
        progress.attempts += 1
        if (payload.kind === "repair") progress.repairs += 1
        if (payload.kind === "takeover") progress.takeovers += 1
        break
      case "turn":
        progress.turns += 1
        break
      case "attempt_result":
        progress.toolOperations += count(payload.tool_operations) ?? 0
        break
      case "approval_resolved":
        if (payload.kind === "scope_expansion" && payload.decision === "approved") {
          progress.scopeExpansions += 1
        }
        break
      case "delivered":
        if (isDelivery(payload.delivery)) progress.delivery = payload.delivery
        if (typeof payload.revision === "string") progress.deliveredRevision = payload.revision
        break
      default:
        break
    }
  }
  progress.empty = !seen
  return progress
}

export interface DelegateAcceptanceFacts {
  tier: unknown
  exit: unknown
  report: unknown
  discovered: unknown
  passed: unknown
  failed: unknown
  errored: unknown
  skipped: unknown
}

/**
 * The checks table's view of a `VerificationReport`.
 *
 * `facts` is what `codeAcceptanceFacts` read back out of the report; a report
 * from another verifier yields nulls, and nulls are rendered as "not
 * recorded". The tier is taken from the report alone — a requested tier that
 * was never attested must never be shown as achieved.
 */
export function delegateAcceptanceFrom(
  report: {
    status: string
    level: string
    revision: string | null
    verifier_version: string
    checks: readonly {
      check_id: string
      kind: string
      status: string
      summary: string
      executed_by: string
    }[]
  },
  facts: DelegateAcceptanceFacts | null
): DelegateAcceptanceView {
  const tier = facts?.tier
  const exit = facts?.exit
  const reportPath = facts?.report
  const checks: DelegateCheckView[] = report.checks.map((check) => ({
    checkId: check.check_id,
    kind: check.kind,
    status: isCheckStatus(check.status) ? check.status : "inconclusive",
    summary: check.summary,
    executedBy:
      check.executed_by === "model" || check.executed_by === "human"
        ? check.executed_by
        : "runtime",
  }))
  return {
    status: isCheckStatus(report.status) ? report.status : "inconclusive",
    level: report.level,
    revision: report.revision,
    verifierVersion: report.verifier_version,
    tier: isTier(tier) ? tier : null,
    exit: typeof exit === "string" ? exit : null,
    report: typeof reportPath === "string" ? reportPath : null,
    discovered: count(facts?.discovered),
    passed: count(facts?.passed),
    failed: count(facts?.failed),
    errored: count(facts?.errored),
    skipped: count(facts?.skipped),
    checks,
    hasModelCheck: checks.some((check) => check.executedBy !== "runtime"),
  }
}

export function delegateApprovalFrom(record: DelegateApprovalRecord): DelegateApprovalView {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    requestDigest: record.requestDigest,
    revision: record.revision,
    paths: [...(record.summary?.paths ?? [])],
    fileCount: record.summary?.fileCount ?? 0,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  }
}

/** The document a `patchArtifactId` holds, parsed only as far as the view needs. */
export interface DelegatePatchDocument {
  base_revision: string
  files: readonly { path: string; action: string; content: string | null }[]
}

export function parseDelegatePatchDocument(raw: string | null): DelegatePatchDocument | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const document = parsed as { base_revision?: unknown; files?: unknown }
  if (typeof document.base_revision !== "string" || !Array.isArray(document.files)) return null
  const files: DelegatePatchDocument["files"] = document.files.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const file = entry as { path?: unknown; action?: unknown; content?: unknown }
    if (typeof file.path !== "string") return []
    if (file.action !== "write" && file.action !== "delete") return []
    return [
      {
        path: file.path,
        action: file.action,
        content: typeof file.content === "string" ? file.content : null,
      },
    ]
  })
  return { base_revision: document.base_revision, files }
}

/**
 * The patch as the review pane renders it: the stored index row, the document
 * it points at, and each file next to the workspace's own copy.
 *
 * A file whose base could not be read keeps `baseState: "unavailable"`, and
 * the pane says so above the diff — an all-added diff with no explanation
 * would read as "this file is new", which is a different claim.
 */
export async function delegatePatchView(
  record: DelegatePatchSetRecord,
  document: string | null,
  comparison: DelegateWorkspaceComparison | null
): Promise<DelegatePatchView> {
  const parsed = parseDelegatePatchDocument(document)
  const files: DelegatePatchFileView[] = []
  for (const file of parsed?.files ?? []) {
    const base: DelegateBaseRead = comparison
      ? await comparison.read(file.path).catch(() => ({ state: "unavailable" }) as const)
      : { state: "unavailable" }
    const baseContent = base.state === "read" ? base.content : null
    files.push({
      path: file.path,
      action: file.action === "delete" ? "delete" : "write",
      newContent: file.action === "delete" ? null : (file.content ?? ""),
      baseContent,
      baseState: base.state,
      unchanged:
        file.action === "write" && base.state === "read" && base.content === (file.content ?? ""),
    })
  }
  return {
    patchSetId: record.patchSetId,
    baseRevision: record.baseRevision,
    resultRevision: record.resultRevision,
    patchSha256: record.patchSha256,
    patchArtifactId: record.patchArtifactId,
    fileCount: record.fileCount,
    paths: [...record.paths],
    delivery: record.delivery,
    appliedRevision: record.appliedRevision,
    appliedAt: record.appliedAt,
    document,
    files,
    comparedRevision: comparison?.revision ?? null,
    comparedAtBase: comparison?.revision === record.baseRevision,
  }
}

// ── loading ──────────────────────────────────────────────────────────────────

export interface DelegateReviewSources {
  run: DelegateRunRecord | null
  events: readonly DelegateRunEventRecord[]
  patchSets: readonly DelegatePatchSetRecord[]
  approvals: readonly DelegateApprovalRecord[]
  readArtifact(artifactId: string): Promise<string | null>
  /** The report the run sealed, already validated; null when there is none. */
  acceptance: DelegateAcceptanceView | null
  comparison: DelegateWorkspaceComparison | null
}

export interface DelegateReviewDeps {
  /** True when the Router + Fusion master switch is on for this account. */
  enabled?: () => Promise<boolean>
  readSources?: (runId: string) => Promise<DelegateReviewSources>
}

async function routerFusionEnabled(): Promise<boolean> {
  const { currentRouterFusionGateSettings } =
    await import("@/lib/router-fusion/gate/current-settings")
  const settings = await currentRouterFusionGateSettings()
  return settings?.routerFusion?.enabled === true
}

/** The whole delegate record of one run, or why there is nothing to show. */
export async function loadDelegateReview(
  runId: string,
  deps: DelegateReviewDeps = {}
): Promise<DelegateReviewState> {
  try {
    if (!(await (deps.enabled ?? routerFusionEnabled)())) return { state: "off" }
  } catch (error) {
    return { state: "unavailable", reason: messageOf(error) }
  }
  let sources: DelegateReviewSources
  try {
    sources = await (deps.readSources ?? readDelegateReviewSources)(runId)
  } catch (error) {
    return { state: "unavailable", reason: messageOf(error) }
  }
  if (!sources.run) return { state: "not-delegate" }
  if (sources.run.mode !== "delegate") return { state: "not-delegate" }

  const approvals = sources.approvals.map(delegateApprovalFrom)
  const newest = sources.patchSets.at(-1) ?? null
  let patch: DelegatePatchView | null = null
  if (newest) {
    let document: string | null = null
    try {
      document = await sources.readArtifact(newest.patchArtifactId)
    } catch {
      // An artifact the content window reaped, or a vault that is locked. The
      // index row still says what the patch touched, so the pane shows that
      // and tells the user the document itself is gone.
      document = null
    }
    patch = await delegatePatchView(newest, document, sources.comparison)
  }
  return {
    state: "ready",
    review: {
      runId,
      status: sources.run.status,
      patch,
      acceptance: sources.acceptance,
      progress: delegateProgressFrom(sources.events),
      approvals,
      pendingApproval: approvals.filter((one) => one.status === "pending").at(-1) ?? null,
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The production read: the fusion database for the run, its journal, its patch
 * sets and its approvals, the sealed result record for the verification
 * report, and the workspace for the diff's other side.
 *
 * Every import here is dynamic, so none of it is on the off path.
 */
export async function readDelegateReviewSources(runId: string): Promise<DelegateReviewSources> {
  const [{ currentFusionStore }, delegateStore] = await Promise.all([
    import("@/lib/router-fusion/chat/store-provider"),
    import("@/lib/router-fusion/db/delegate-store"),
  ])
  const store = await currentFusionStore()
  const run = await store.getRun(runId)
  if (!run || run.mode !== "delegate") {
    return {
      run: null,
      events: [],
      patchSets: [],
      approvals: [],
      readArtifact: async () => null,
      acceptance: null,
      comparison: null,
    }
  }
  const artifacts = store.artifactStore(runId)
  const readArtifact = async (artifactId: string): Promise<string | null> =>
    (await artifacts.get(artifactId))?.content ?? null
  const [events, patchSets, approvals] = await Promise.all([
    store.db.fusionRunEvents.where("runId").equals(runId).sortBy("seq"),
    delegateStore.listRunPatchSets(store.db, runId),
    delegateStore.listRunApprovals(store.db, runId),
  ])
  return {
    run: {
      runId: run.runId,
      mode: run.mode,
      status: run.status,
      resultRecordArtifactId: run.resultRecordArtifactId ?? null,
      workspaceRoot: run.workspaceRoot ?? null,
      projectId: run.projectId ?? null,
    },
    events: events.map((event) => ({ type: event.type, payload: event.payload })),
    patchSets,
    approvals: approvals.map((row) => ({
      id: row.id,
      kind: row.kind,
      requestDigest: row.requestDigest,
      revision: row.revision,
      status: row.status,
      summary: {
        paths: row.summary?.paths ?? [],
        fileCount: row.summary?.fileCount ?? 0,
        patchSha256: row.summary?.patchSha256 ?? null,
        patchArtifactId: row.summary?.patchArtifactId ?? null,
      },
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
    })),
    acceptance: await readSealedAcceptance(run.resultRecordArtifactId ?? null, readArtifact),
    comparison: await openWorkspaceComparison(run.workspaceRoot ?? null),
  }
}

/**
 * The verification report the run sealed with its result, validated against
 * the contract schema before a single number of it is shown. An invalid or
 * missing record answers null: the checks table then says nothing was
 * verified, which is the honest reading of a report that cannot be parsed.
 */
async function readSealedAcceptance(
  resultRecordArtifactId: string | null,
  readArtifact: (artifactId: string) => Promise<string | null>
): Promise<DelegateAcceptanceView | null> {
  if (!resultRecordArtifactId) return null
  let raw: string | null = null
  try {
    raw = await readArtifact(resultRecordArtifactId)
  } catch {
    return null
  }
  if (!raw) return null
  let record: unknown
  try {
    record = JSON.parse(raw)
  } catch {
    return null
  }
  const verification = (record as { verification?: unknown } | null)?.verification
  if (!verification) return null
  const [{ VerificationReportSchema }, { codeAcceptanceFacts }] = await Promise.all([
    import("@cognia/router-fusion/contracts/schemas"),
    import("@cognia/router-fusion/verify/code-acceptance"),
  ])
  const parsed = VerificationReportSchema.safeParse(verification)
  if (!parsed.success) return null
  return delegateAcceptanceFrom(parsed.data, codeAcceptanceFacts(parsed.data))
}

/**
 * The workspace side of the diff, read through the same guarded host command
 * the delegate tools use (`fs_read_workspace_file`, realpath-confined).
 *
 * It reads the workspace as it is NOW and reports which revision that is, so
 * the pane can say whether the comparison is against the patch's base. No
 * worktree is provisioned: a review is a read, and provisioning one here would
 * be a side effect nobody asked for.
 */
async function openWorkspaceComparison(
  workspaceRoot: string | null
): Promise<DelegateWorkspaceComparison | null> {
  if (!workspaceRoot) return null
  const { defaultDelegateWorkspaceHost } = await import("@/lib/router-fusion/tools/workspace-patch")
  const host = defaultDelegateWorkspaceHost()
  const revision = await host.revision(workspaceRoot).catch(() => null)
  return {
    revision,
    async read(path: string): Promise<DelegateBaseRead> {
      try {
        const stat = await host.stat(workspaceRoot, path)
        if (!stat.exists || stat.isDir) return { state: "absent" }
        return { state: "read", content: await host.readFile(workspaceRoot, path, 512 * 1024) }
      } catch {
        return { state: "unavailable" }
      }
    },
  }
}
