/**
 * Issue tracker API surface, published as `@cognia/plugin-sdk/api/issues`
 * (spec 2026-09-06 D9).
 *
 * Runtime operations live on `ctx.issues`. What ships here is the shape of
 * that surface plus the domain vocabulary an author needs to satisfy it, so
 * every export below is a type: the host owns the behaviour, and the same
 * `lib/issues/service.ts` gate that refuses a move on the board refuses it
 * for a plugin.
 */

export type {
  PluginIssuesAPI,
  PluginIssueCreateInput,
  PluginIssueQuery,
  PluginIssueUpdatePatch,
  PluginIssueEventOptions,
} from "@/lib/plugin/api/issues-api"

export type { IssueBulkAction, IssueBulkOutcome, IssueWire } from "@/lib/issues/service"

export type {
  IssueSyncBinding,
  IssueSyncProvider,
  PullOptions,
  PullResult,
  PushOutcome,
  RemoteCycle,
  RemoteIssue,
  RemoteLink,
  RemotePatch,
} from "@/lib/issues/sync/types"

export type {
  Issue,
  IssueActor,
  IssueCycle,
  IssueEvent,
  IssueEventKind,
  IssueEventPayload,
  IssueExternalRef,
  IssueOrigin,
  IssuePriority,
  IssueProject,
  IssueStatus,
  IssueSyncField,
} from "@/types/issues"
