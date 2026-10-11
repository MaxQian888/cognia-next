/**
 * The approvals an unattended run is waiting on, for a paired phone (ADR-0224 A7).
 *
 * `execution_run_approval_list` and `execution_run_approval_respond` are the phone's side of a
 * parked run: the pending `tool_approval` interrupts unattended turns raised
 * and the pending `bot_approval` interrupts Bot handlers raised, and an answer
 * to one of them.
 *
 * The answer is the human approval itself, the way `claude_approve` answers a
 * permission request on a paired chat, so it carries no admin lease: on a
 * headless host the phone could not get its own lease approved, and an
 * approval that needs a second device to approve the approval is not one a
 * person can give from the lock screen. What keeps it narrow:
 *
 *   - only these two interrupt kinds, only while pending;
 *   - it goes through `executeRunControlCommand`, the cockpit's own gate, so
 *     revision checks, idempotency, expiry and the run kind's handler (the
 *     agent-turn handler resolves the parked request) apply unchanged;
 *   - the actor is the authenticated device the host stamped
 *     (`callerDeviceId`), never one the payload names.
 */

import type { PermissionClass } from "@cognia/agent-config-types"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { localConsoleOperatorIds } from "@/lib/execution/local-operator"
import type { Page } from "@/lib/tauri/companion-paging"
import type { ExecutionRunInterrupt, ExecutionRunKind } from "@/types/execution/run"

import { executeRunControlCommand, type RunControlResult } from "./run-control"
import {
  RUN_APPROVAL_TYPES,
  announceRunApprovalResolved,
  isRunApprovalType,
  type RunApprovalType,
} from "./run-approval-push"

/** Largest Bot approval detail a phone gets inline; a bigger one is opened on the host. */
export const RUN_APPROVAL_DETAIL_MAX_CHARS = 4_000

/** Page sizes for `execution_run_approval_list` (ADR-0175 B3 page-token). */
export const RUN_APPROVAL_PAGE_SIZE_DEFAULT = 50
export const RUN_APPROVAL_PAGE_SIZE_MAX = 200

const PAGE_TOKEN_PREFIX = "ra:"

/** A list request this host cannot answer: a bad size or a token it never issued. */
export class RunApprovalListRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunApprovalListRequestError"
  }
}

/** Opaque to the client: the offset into the oldest-first list. */
function encodePageToken(offset: number): string {
  return `${PAGE_TOKEN_PREFIX}${offset}`
}

export function parseRunApprovalListRequest(payload: Record<string, unknown>): {
  pageSize: number
  offset: number
} {
  let pageSize = RUN_APPROVAL_PAGE_SIZE_DEFAULT
  const rawSize = payload.pageSize
  if (rawSize !== undefined) {
    if (
      typeof rawSize !== "number" ||
      !Number.isSafeInteger(rawSize) ||
      rawSize < 1 ||
      rawSize > RUN_APPROVAL_PAGE_SIZE_MAX
    ) {
      throw new RunApprovalListRequestError(
        `pageSize must be an integer from 1 to ${RUN_APPROVAL_PAGE_SIZE_MAX}`
      )
    }
    pageSize = rawSize
  }
  let offset = 0
  const token = payload.pageToken
  if (token !== undefined) {
    const parsed =
      typeof token === "string" && token.startsWith(PAGE_TOKEN_PREFIX)
        ? Number(token.slice(PAGE_TOKEN_PREFIX.length))
        : Number.NaN
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new RunApprovalListRequestError("pageToken is not a token this host issued")
    }
    offset = parsed
  }
  return { pageSize, offset }
}

export interface RunApprovalSummary {
  interruptId: string
  runId: string
  type: RunApprovalType
  /** What the question is ("Approve im_send (outbound message)", a Bot's title). */
  title: string
  /** The run it belongs to ("Bot: Release notes", "Scheduled task: Digest"). */
  runTitle: string
  runKind: ExecutionRunKind
  toolName?: string
  permissionClass?: PermissionClass
  /** A Bot's own message to the approver. */
  message?: string
  risk?: "low" | "medium" | "high"
  /** A Bot's proposal, when small enough to show on a phone. */
  detail?: Record<string, unknown>
  /** The proposal exists but is too large to show inline. */
  detailTruncated?: boolean
  createdAt: number
  expiresAt: number
}

/**
 * One page of the approvals still waiting on a person, oldest first.
 *
 * The list is short in practice (a run parks one request at a time), but it
 * is a list verb and pages like one: a token is an offset into the same
 * oldest-first order, so a page boundary can shift by the rows answered in
 * between, which a caller walking every page tolerates by reloading on the
 * resolved event.
 */
export async function listRunApprovals(
  payload: Record<string, unknown> = {},
  now: number = Date.now()
): Promise<Page<RunApprovalSummary>> {
  const { pageSize, offset } = parseRunApprovalListRequest(payload)
  const pending = await getDb().executionRunInterrupts.where("status").equals("pending").toArray()
  const live = pending
    .filter((row) => isRunApprovalType(row.type) && row.expiresAt > now)
    .sort((a, b) => a.createdAt - b.createdAt)
  const approvals: RunApprovalSummary[] = []
  for (const row of live) {
    const run = await getExecutionRun(row.runId)
    if (!run) continue
    approvals.push(summarise(row, run.title, run.kind))
  }
  const items = approvals.slice(offset, offset + pageSize)
  const next = offset + pageSize
  return {
    items,
    ...(next < approvals.length ? { nextPageToken: encodePageToken(next) } : {}),
  }
}

function summarise(
  row: ExecutionRunInterrupt,
  runTitle: string,
  runKind: ExecutionRunKind
): RunApprovalSummary {
  const detail = row.approvalDetail
  const detailSize = detail ? JSON.stringify(detail).length : 0
  return {
    interruptId: row.id,
    runId: row.runId,
    type: row.type as RunApprovalType,
    title: row.title,
    runTitle,
    runKind,
    ...(row.toolName ? { toolName: row.toolName } : {}),
    ...(row.permissionClass ? { permissionClass: row.permissionClass } : {}),
    ...(row.approvalMessage ? { message: row.approvalMessage } : {}),
    ...(row.approvalRisk ? { risk: row.approvalRisk } : {}),
    ...(detail && detailSize <= RUN_APPROVAL_DETAIL_MAX_CHARS ? { detail } : {}),
    ...(detail && detailSize > RUN_APPROVAL_DETAIL_MAX_CHARS ? { detailTruncated: true } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

export type RunApprovalRespondOutcome =
  | { ok: true; status: "approved" | "denied" }
  | {
      ok: false
      reason: "invalid-payload" | "gone" | NonNullable<RunControlResult["reason"]>
      field?: string
    }

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export interface RespondDeps {
  execute?: typeof executeRunControlCommand
  operatorIds?: () => readonly string[]
  announceResolved?: typeof announceRunApprovalResolved
}

/** Answer one pending approval as the calling device. */
export async function respondRunApproval(
  payload: Record<string, unknown>,
  deps: RespondDeps = {}
): Promise<RunApprovalRespondOutcome> {
  const interruptId = readString(payload, "interruptId")
  if (!interruptId) return { ok: false, reason: "invalid-payload", field: "interruptId" }
  const decision = payload.decision
  if (decision !== "approve" && decision !== "deny") {
    return { ok: false, reason: "invalid-payload", field: "decision" }
  }
  const deviceId = readString(payload, "callerDeviceId")
  if (!deviceId) return { ok: false, reason: "invalid-payload", field: "callerDeviceId" }
  const displayName = readString(payload, "deviceName")

  const interrupt = await getDb().executionRunInterrupts.get(interruptId)
  if (!interrupt || !isRunApprovalType(interrupt.type) || interrupt.status !== "pending") {
    return { ok: false, reason: "gone" }
  }
  const run = await getExecutionRun(interrupt.runId)
  if (!run) return { ok: false, reason: "gone" }

  const result = await (deps.execute ?? executeRunControlCommand)(
    {
      runId: run.id,
      action: decision,
      idempotencyKey: `run-approval:${interruptId}:${decision}`,
      expectedRevision: run.currentRevision,
      actor: { remoteUserId: deviceId, ...(displayName ? { displayName } : {}) },
      interruptId,
    },
    { operatorIds: [...(deps.operatorIds ?? localConsoleOperatorIds)(), deviceId] }
  )
  if (!result.accepted) return { ok: false, reason: result.reason ?? "source_rejected" }
  const status = decision === "approve" ? "approved" : "denied"
  // A parked tool approval announces its own resolution when the turn wakes;
  // a Bot's approval is only observed at its next re-entry, so say it now.
  if (interrupt.type === "bot_approval") {
    await (deps.announceResolved ?? announceRunApprovalResolved)({
      interruptId,
      runId: run.id,
      status,
    })
  }
  return { ok: true, status }
}

export { RUN_APPROVAL_TYPES }
