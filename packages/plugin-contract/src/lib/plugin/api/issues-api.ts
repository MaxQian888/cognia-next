/**
 * The plugin contract's share of `lib/plugin/api/issues-api.ts`, which re-exports these.
 */
import type { CreateIssueRequest, IssueQuery, IssueWire } from "../../issues/service"
import type {
  IssueActor,
  IssueEvent,
  IssueEventKind,
  IssueTriageState,
} from "../../../types/issues/index"
import type { IssueBulkOutcome } from "../../issues/bulk-actions"
import type { IssueEventListener } from "../../issues/event-bus"
import type { IssueSyncProvider } from "../../issues/sync/types"

export type PluginIssueCreateInput = Omit<CreateIssueRequest, "by" | "origin">

export type PluginIssueQuery = IssueQuery

export interface PluginIssueUpdatePatch {
  title?: string
  description?: string
  status?: string
  priority?: string
  /** `null` clears. */
  dueDate?: number | null
  estimate?: number | null
  cycleId?: string | null
  /** Sub-issue stage, 1 to `ISSUE_STAGE_MAX`. `null` unstages. */
  stage?: number | null
  /** `"pending"` sends it into triage, `null` accepts it out. */
  triage?: IssueTriageState | null
}

export interface PluginIssueEventOptions {
  kinds?: readonly IssueEventKind[]
  issueId?: string
}

export interface PluginIssuesAPI {
  /** By row id or printed identifier (`MERC-12`). `null` when nothing matches. */
  get(ref: string): Promise<IssueWire | null>
  list(query?: PluginIssueQuery): Promise<IssueWire[]>
  /** The trail, newest first. */
  listEvents(ref: string, limit?: number): Promise<IssueEvent[]>
  create(input: PluginIssueCreateInput): Promise<IssueWire>
  /** Each given field becomes one board action. The outcome counts them. */
  update(ref: string, patch: PluginIssueUpdatePatch): Promise<IssueBulkOutcome>
  assign(ref: string, assignee: IssueActor | null): Promise<IssueBulkOutcome>
  comment(ref: string, body: string): Promise<IssueBulkOutcome>
  /** Label NAMES. Adds create missing labels, removes never do. */
  label(
    ref: string,
    change: { add?: readonly string[]; remove?: readonly string[] }
  ): Promise<IssueBulkOutcome>
  /** Subscribe to committed trail entries. Returns the disposer. */
  onEvent(handler: IssueEventListener, options?: PluginIssueEventOptions): () => void
  /** Register an external tracker as a sync source. Returns the disposer. */
  registerSyncProvider(provider: IssueSyncProvider): () => void
}
