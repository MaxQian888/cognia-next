/**
 * The tool runtime a Router + Fusion run's models request tools through
 * (ADR-0188 D26, DESIGN §11).
 *
 * A model only ever produces a request. This runtime decides it: the policy
 * must offer the tool, the tool must be read-only, the arguments must parse,
 * and then — and only then — it runs. Nothing a page, a candidate or a prompt
 * says changes that decision (AUTH-05); a tool the policy does not name is
 * refused and recorded whatever it is called.
 *
 * Every operation is recorded in `fusionToolOperations`, keyed by what makes it
 * the same operation: the step, the policy, the tool, its canonical arguments —
 * and, for a workspace read, the hash of the content it read. A repeat returns
 * the stored receipt; a changed file is a new operation (CACHE-02). What a
 * model was shown is stored as an encrypted artifact, and what it read is
 * stored as evidence, pinned by its SHA-256.
 *
 * Three policies:
 *  - `panel-read-1` — a candidate's one tool round: public pages, web search,
 *    and (when the run has a workspace the person at this device chose) files.
 *  - `panel-verify-1` — the judge's verification requests: re-read stored
 *    evidence, and re-fetch a page to check it still says the same thing.
 *    `compute` and `test` are not offered: a panel has no sandbox.
 *  - `delegate-work-1` — a delegate worker's tools (ADR-0188 B4): read and
 *    list the workspace AT THE RUN'S REVISION, and propose a whole-file patch.
 *    It is the only policy with a non-read-only tool, and the exception is
 *    narrow on purpose: `propose_patch` writes nothing anywhere. It authorises
 *    a path against the subtask's scope and records the proposal; the patch
 *    reaches a disk only when the workflow stages it into an isolated worktree,
 *    and a person's workspace only through an approved compare-and-swap.
 */

import {
  canonicalHash,
  sha256Hex,
  type EvidenceCheck,
  type EvidenceRef,
  type EvidenceResolver,
  type ToolContext,
  type ToolDescriptor,
  type ToolIntent,
  type ToolReceipt,
  type ToolRuntime,
  type DelegateToolContext,
  type DelegateToolRuntime,
  type WorkspaceListResult,
  type WorkspacePort,
  type WorkspaceReadResult as DelegateWorkspaceReadResult,
} from "@cognia/router-fusion"
import { z } from "zod"

import { persistableText, type FusionLedgerStore } from "../db/ledger-store"
import type { FusionToolOperationRow } from "../db/types"
import {
  DELEGATE_LIST_LIMIT,
  DELEGATE_READ_MAX_BYTES,
  DELEGATE_TOOL_NAMES,
  DELEGATE_WORK_POLICY,
  DelegateToolArgs,
  delegatePatchLimitRefusal,
  delegateWorkTools,
  delegateWriteAllowed,
  normalizeDelegateHostPath,
} from "./delegate-tool-policy"
import type { SsrfAuditEntry, WebEvidence } from "./web-evidence"
import type { WorkspaceReader, WorkspaceReadResult } from "./workspace-read"

export const PANEL_READ_POLICY = "panel-read-1"
export const PANEL_VERIFY_POLICY = "panel-verify-1"
export { DELEGATE_WORK_POLICY } from "./delegate-tool-policy"

/** Characters of a read the model is shown; the full content is the evidence artifact. */
export const TOOL_SUMMARY_CHARS = 6_000

const WEB_FETCH: ToolDescriptor = {
  name: "web_fetch",
  description: "Read one public web page. Returns its text and an evidence reference you can cite.",
  parameters: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: { url: { type: "string", description: "An http(s) URL on the public internet." } },
  },
  toolClass: "read_only",
}

const WEB_SEARCH: ToolDescriptor = {
  name: "web_search",
  description: "Search the web. Returns titles, URLs and snippets; fetch a page to cite it.",
  parameters: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: { query: { type: "string" } },
  },
  toolClass: "read_only",
}

const WORKSPACE_READ: ToolDescriptor = {
  name: "workspace_read",
  description: "Read one text file of the workspace, by its path relative to the workspace root.",
  parameters: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: { path: { type: "string" } },
  },
  toolClass: "read_only",
}

const ARTIFACT_READ: ToolDescriptor = {
  name: "artifact_read",
  description: "Re-read stored evidence of this run and confirm it is intact.",
  parameters: {
    type: "object",
    required: ["artifact_ids", "question"],
    additionalProperties: false,
    properties: {
      artifact_ids: { type: "array", items: { type: "string" } },
      question: { type: "string" },
    },
  },
  toolClass: "read_only",
}

const SOURCE_CHECK: ToolDescriptor = {
  name: "source_check",
  description: "Fetch the page a piece of evidence came from again and report whether it changed.",
  parameters: ARTIFACT_READ.parameters,
  toolClass: "read_only",
}

const Args = {
  web_fetch: z.strictObject({ url: z.string().min(1).max(4096) }),
  web_search: z.strictObject({ query: z.string().min(1).max(500) }),
  workspace_read: z.strictObject({ path: z.string().min(1).max(1024) }),
  artifact_read: z.strictObject({
    artifact_ids: z.array(z.string()).min(1).max(8),
    question: z.string().max(2000),
  }),
  source_check: z.strictObject({
    artifact_ids: z.array(z.string()).min(1).max(4),
    question: z.string().max(2000),
  }),
  // `delegate-work-1`. `workspace_read` is shared with the panel: one path,
  // and the same schema whichever policy asks.
  workspace_list: DelegateToolArgs.workspace_list,
  propose_patch: DelegateToolArgs.propose_patch,
} as const

type ToolName = keyof typeof Args

/** The workspace a delegate run reads at a revision and proposes patches into. */
export interface DelegateToolDeps {
  workspace: WorkspacePort
}

export interface HostToolRuntimeDeps {
  store: FusionLedgerStore
  runId: string
  web: WebEvidence | null
  workspace: WorkspaceReader | null
  /** Present only for a delegate run; absent, `delegate-work-1` offers nothing. */
  delegate?: DelegateToolDeps | null
  now: () => number
}

/** The delegate context a `delegate-work-1` call must carry, or null. */
function delegateContextOf(context: ToolContext): DelegateToolContext | null {
  if (context.policyId !== DELEGATE_WORK_POLICY) return null
  const candidate = context as DelegateToolContext
  return typeof candidate.revision === "string" &&
    candidate.revision.length > 0 &&
    Array.isArray(candidate.allowedPaths)
    ? candidate
    : null
}

interface Outcome {
  status: ToolReceipt["status"]
  refusalCode?: string
  evidence: EvidenceRef[]
  summary: string
  audit?: SsrfAuditEntry[]
}

function excerpt(text: string, artifactId: string | null): string {
  if (text.length <= TOOL_SUMMARY_CHARS) return text
  return `${text.slice(0, TOOL_SUMMARY_CHARS)}\n… [truncated; the full text is evidence ${artifactId ?? "unavailable"}]`
}

function refused(code: string): Outcome {
  return { status: "refused", refusalCode: code, evidence: [], summary: `refused: ${code}` }
}

/** What a `delegate-work-1` call read before it was decided. */
type PreparedDelegateCall =
  | { kind: "invalid"; code: string }
  | { kind: "read"; path: string; read: DelegateWorkspaceReadResult }
  | { kind: "list"; prefix: string; listing: WorkspaceListResult }
  | {
      kind: "patch"
      path: string
      action: "write" | "delete"
      bytes: number
      probe: DelegateWorkspaceReadResult
    }

/** The content half of a delegate operation's identity (CACHE-02). */
function delegateIdentity(prepared: PreparedDelegateCall): string {
  switch (prepared.kind) {
    case "invalid":
      return prepared.code
    case "read":
      return prepared.read.ok ? prepared.read.contentSha256 : prepared.read.code
    case "list":
      return prepared.listing.ok ? canonicalHash(prepared.listing.files) : prepared.listing.code
    case "patch":
      return prepared.probe.ok ? prepared.probe.contentSha256 : prepared.probe.code
  }
}

export function createHostToolRuntime(
  deps: HostToolRuntimeDeps
): ToolRuntime & DelegateToolRuntime {
  const { store, runId } = deps
  const artifacts = store.artifactStore(runId)

  const describe = (policyId: string): ToolDescriptor[] => {
    if (policyId === PANEL_READ_POLICY) {
      return [
        ...(deps.web ? [WEB_FETCH] : []),
        ...(deps.web?.search ? [WEB_SEARCH] : []),
        ...(deps.workspace ? [WORKSPACE_READ] : []),
      ]
    }
    if (policyId === PANEL_VERIFY_POLICY) {
      return [ARTIFACT_READ, ...(deps.web ? [SOURCE_CHECK] : [])]
    }
    if (policyId === DELEGATE_WORK_POLICY) return delegateWorkTools(deps.delegate != null)
    return []
  }

  const storeEvidence = async (content: string, locator: string): Promise<EvidenceRef> => {
    const stored = await artifacts.put(content, "text/plain", `runs/${runId}/evidence`)
    return {
      artifact_id: stored.artifactId,
      content_sha256: stored.contentSha256,
      locator,
      retrieved_at: new Date(deps.now()).toISOString(),
    }
  }

  /** The evidence of this run's own tool operations, by artifact id. */
  const knownEvidence = async (): Promise<Map<string, EvidenceRef>> => {
    const rows = await store.db.fusionToolOperations.where("runId").equals(runId).toArray()
    const map = new Map<string, EvidenceRef>()
    for (const row of rows) for (const ref of row.evidence) map.set(ref.artifact_id, ref)
    return map
  }

  const run = async (name: ToolName, args: unknown, context: ToolContext): Promise<Outcome> => {
    switch (name) {
      case "web_fetch": {
        const { url } = args as z.infer<typeof Args.web_fetch>
        const page = await deps.web!.fetchPage(url, context.signal)
        if (!page.ok) {
          return page.code === "SSRF_BLOCKED"
            ? { ...refused("SSRF_BLOCKED"), audit: page.audit }
            : { status: "failed", evidence: [], summary: page.message }
        }
        const ref = await storeEvidence(page.content, page.finalUrl)
        const header = [
          page.title,
          page.finalUrl,
          page.truncated ? "(the page was longer; this is its beginning)" : null,
        ]
          .filter(Boolean)
          .join("\n")
        return {
          status: "succeeded",
          evidence: [ref],
          summary: `${header}\n\n${excerpt(page.content, ref.artifact_id)}`,
        }
      }
      case "web_search": {
        const { query } = args as z.infer<typeof Args.web_search>
        const hits = await deps.web!.search!(query, context.signal)
        if (!hits)
          return { status: "failed", evidence: [], summary: "the search returned nothing usable" }
        const listing = hits
          .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}`)
          .join("\n")
        // What the search said is recorded; a page must still be fetched to be cited as a fact.
        const ref = await storeEvidence(listing, `search:${query}`)
        return { status: "succeeded", evidence: [ref], summary: excerpt(listing, ref.artifact_id) }
      }
      case "workspace_read": {
        // Read once, in `execute`: the content that names the operation is the content recorded.
        const read = args as WorkspaceReadResult
        if (!read.ok) {
          return read.code === "READ_FAILED"
            ? { status: "failed", evidence: [], summary: read.message }
            : refused(read.code)
        }
        const ref = await storeEvidence(
          read.content,
          `workspace:${read.relPath}@${read.contentSha256.slice(0, 12)}`
        )
        return {
          status: "succeeded",
          evidence: [ref],
          summary: `${read.relPath}${read.truncated ? " (truncated)" : ""}\n\n${excerpt(read.content, ref.artifact_id)}`,
        }
      }
      case "artifact_read": {
        const { artifact_ids } = args as z.infer<typeof Args.artifact_read>
        const known = await knownEvidence()
        const lines: string[] = []
        const evidence: EvidenceRef[] = []
        for (const id of artifact_ids) {
          const ref = known.get(id)
          if (!ref) {
            lines.push(`${id}: not evidence of this run`)
            continue
          }
          try {
            const stored = await artifacts.get(id)
            if (!stored) {
              lines.push(`${id}: no longer available`)
              continue
            }
            evidence.push(ref)
            lines.push(`${id} (${ref.locator}): intact\n${excerpt(stored.content, id)}`)
          } catch {
            lines.push(`${id}: failed its integrity check`)
          }
        }
        return {
          status: evidence.length > 0 ? "succeeded" : "failed",
          evidence,
          summary: lines.join("\n\n"),
        }
      }
      case "source_check": {
        const { artifact_ids } = args as z.infer<typeof Args.source_check>
        const known = await knownEvidence()
        const lines: string[] = []
        const evidence: EvidenceRef[] = []
        for (const id of artifact_ids) {
          const ref = known.get(id)
          if (!ref || !/^https?:\/\//.test(ref.locator)) {
            lines.push(`${id}: not a web page this run read`)
            continue
          }
          const page = await deps.web!.fetchPage(ref.locator, context.signal)
          if (!page.ok) {
            lines.push(`${id}: the source could not be re-read (${page.code})`)
            continue
          }
          const fresh = await storeEvidence(page.content, page.finalUrl)
          evidence.push(fresh)
          lines.push(
            sha256Hex(page.content) === ref.content_sha256
              ? `${id}: unchanged at ${ref.locator}`
              : `${id}: CHANGED at ${ref.locator}; the current text is evidence ${fresh.artifact_id}`
          )
        }
        return {
          status: evidence.length > 0 ? "succeeded" : "failed",
          evidence,
          summary: lines.join("\n"),
        }
      }
      default:
        // The `delegate-work-1` tools; they never reach here, because that
        // policy always runs through `runDelegate`, and a policy that offers
        // them without a delegate workspace offers nothing at all.
        return refused("TOOL_NOT_IMPLEMENTED")
    }
  }

  /**
   * One `delegate-work-1` call, already validated. The read happens here and
   * in `prepareDelegate`, once: the content that names the operation is the
   * content recorded, exactly as the panel's workspace read (CACHE-02).
   */
  const runDelegate = async (
    prepared: PreparedDelegateCall,
    context: DelegateToolContext
  ): Promise<Outcome> => {
    switch (prepared.kind) {
      case "invalid":
        return refused(prepared.code)
      case "read": {
        const read = prepared.read
        if (!read.ok) {
          return read.code === "NOT_FOUND" || read.code === "REVISION_UNKNOWN"
            ? { status: "failed", evidence: [], summary: `${read.code}: ${read.message}` }
            : refused(read.code)
        }
        const ref = await storeEvidence(
          read.content,
          `workspace:${context.revision}:${prepared.path}`
        )
        return {
          status: "succeeded",
          evidence: [ref],
          summary: `${prepared.path}${read.truncated ? " (truncated)" : ""}\n\n${excerpt(read.content, ref.artifact_id)}`,
        }
      }
      case "list": {
        const listed = prepared.listing
        if (!listed.ok) return refused(listed.code)
        const body = listed.files.map((file) => `${file.path} (${file.sizeBytes} B)`).join("\n")
        return {
          status: "succeeded",
          evidence: [],
          summary: (body || "(no file matches)") + (listed.truncated ? "\n… (more files)" : ""),
        }
      }
      case "patch": {
        // Nothing is written: the proposal is recorded, and the workflow
        // stages the whole patch into an isolated worktree when the session
        // ends. A path outside the subtask's scope needs a person (DEL-07).
        if (!delegateWriteAllowed(prepared.path, context.allowedPaths)) {
          return refused("PATH_OUT_OF_SCOPE")
        }
        if (prepared.probe && !prepared.probe.ok) {
          const code = prepared.probe.code
          if (code !== "NOT_FOUND" && code !== "CONTENT_SENSITIVE") return refused(code)
        }
        const limit = delegatePatchLimitRefusal({
          files: 1,
          fileBytes: prepared.bytes,
          totalBytes: prepared.bytes,
        })
        if (limit) return refused(limit)
        return {
          status: "succeeded",
          evidence: [],
          summary:
            prepared.action === "write"
              ? `proposed: write ${prepared.path} (${prepared.bytes} bytes)`
              : `proposed: delete ${prepared.path}`,
        }
      }
    }
  }

  /**
   * Read what the call needs before it is executed, so the operation's
   * identity covers the content it acted on and a repeat returns the stored
   * receipt instead of reading a file that has since changed.
   */
  const prepareDelegate = async (
    name: string,
    args: unknown,
    context: DelegateToolContext
  ): Promise<PreparedDelegateCall> => {
    const workspace = deps.delegate!.workspace
    if (name === DELEGATE_TOOL_NAMES.read) {
      const { path } = args as { path: string }
      const normalized = normalizeDelegateHostPath(path)
      if (!normalized.ok) return { kind: "invalid", code: normalized.code }
      return {
        kind: "read",
        path: normalized.path,
        read: await workspace.readFile({
          path: normalized.path,
          revision: context.revision,
          maxBytes: DELEGATE_READ_MAX_BYTES,
        }),
      }
    }
    if (name === DELEGATE_TOOL_NAMES.list) {
      const { prefix } = args as { prefix: string }
      return {
        kind: "list",
        prefix,
        listing: await workspace.listFiles({
          prefix,
          revision: context.revision,
          limit: DELEGATE_LIST_LIMIT,
        }),
      }
    }
    const patch = args as { path: string; action: "write" | "delete"; content?: string }
    const normalized = normalizeDelegateHostPath(patch.path)
    if (!normalized.ok) return { kind: "invalid", code: normalized.code }
    const bytes =
      patch.action === "write" ? new TextEncoder().encode(patch.content ?? "").byteLength : 0
    // A one-byte read is the cheapest way to ask the host "may this path be
    // touched at all?" — it applies the same symlink and escape rules a real
    // read does, without returning content.
    const probe = await workspace.readFile({
      path: normalized.path,
      revision: context.revision,
      maxBytes: 1,
    })
    return { kind: "patch", path: normalized.path, action: patch.action, bytes, probe }
  }

  const receiptOf = async (
    row: FusionToolOperationRow,
    toolCallId: string
  ): Promise<ToolReceipt> => {
    const summary = row.summaryArtifactId
      ? (await artifacts.get(row.summaryArtifactId))?.content
      : undefined
    return {
      operationId: row.operationId,
      toolCallId,
      name: row.toolName,
      status: row.status,
      ...(row.refusalCode ? { refusalCode: row.refusalCode } : {}),
      evidence: row.evidence,
      summary:
        summary ??
        (row.refusalCode ? `refused: ${row.refusalCode}` : "(the result is no longer available)"),
    }
  }

  return {
    describe,
    async execute(intent: ToolIntent, context: ToolContext): Promise<ToolReceipt> {
      const offered = describe(context.policyId).find((tool) => tool.name === intent.name)
      const argsHash = canonicalHash(intent.arguments ?? {})
      let outcome: Outcome | null = null
      let identity: Record<string, unknown> = {
        step: context.logicalStepId,
        policy: context.policyId,
        tool: intent.name,
        args: argsHash,
      }
      // `delegate-work-1` is the only policy with a write, and only for
      // `propose_patch`, which writes nothing (see the module header).
      const delegate = deps.delegate ? delegateContextOf(context) : null
      const writeAllowed =
        delegate !== null &&
        offered?.name === DELEGATE_TOOL_NAMES.proposePatch &&
        offered.toolClass === "sandbox_write"
      if (!offered) outcome = refused("TOOL_NOT_OFFERED")
      else if (offered.toolClass !== "read_only" && !writeAllowed) {
        outcome = refused("WRITE_NOT_PERMITTED")
      } else if (context.policyId === DELEGATE_WORK_POLICY && !delegate) {
        // A delegate tool without the run's revision and write scope is a
        // call nothing can authorise, whatever it asks for.
        outcome = refused("TOOL_CONTEXT_INVALID")
      }
      const parser = offered ? Args[offered.name as ToolName] : undefined
      const parsed = !outcome && parser ? parser.safeParse(intent.arguments) : null
      if (!outcome && !parsed?.success) outcome = refused("INVALID_ARGUMENTS")

      // A workspace read is the same operation only on the same content.
      let toolArgs: unknown = parsed?.success ? parsed.data : undefined
      let prepared: PreparedDelegateCall | null = null
      if (!outcome && delegate) {
        prepared = await prepareDelegate(offered!.name, toolArgs, delegate)
        identity = {
          ...identity,
          revision: delegate.revision,
          scope: canonicalHash([...delegate.allowedPaths].sort()),
          content: delegateIdentity(prepared),
        }
        if (prepared.kind === "invalid") outcome = refused(prepared.code)
      } else if (!outcome && offered?.name === "workspace_read") {
        const read = await deps.workspace!.read((toolArgs as { path: string }).path)
        identity = { ...identity, content: read.ok ? read.contentSha256 : read.code }
        toolArgs = read
      }
      const operationId = canonicalHash(identity)
      const existing = await store.db.fusionToolOperations.get(operationId)
      if (existing) return receiptOf(existing, intent.id)

      outcome ??=
        prepared && delegate
          ? await runDelegate(prepared, delegate)
          : await run(offered!.name as ToolName, toolArgs, context)
      const summaryArtifact =
        outcome.status === "refused"
          ? null
          : await artifacts.put(outcome.summary, "text/plain", `runs/${runId}/tools`)
      const row: FusionToolOperationRow = {
        operationId,
        runId,
        logicalStepId: context.logicalStepId,
        policyId: context.policyId,
        // The name is the model's text: only a machine-shaped one is kept.
        toolName: persistableText(intent.name),
        argsHash,
        status: outcome.status,
        refusalCode: outcome.refusalCode ?? null,
        evidence: outcome.evidence,
        summaryArtifactId: summaryArtifact?.artifactId ?? null,
        ...(outcome.audit && outcome.audit.length > 0 ? { audit: outcome.audit } : {}),
        createdAt: deps.now(),
      }
      await store.db.fusionToolOperations.put(row)
      if (outcome.audit && outcome.audit.length > 0) {
        console.warn(
          `[router-fusion] refused a ${intent.name} request of run ${runId} to a non-public address`,
          outcome.audit
            .map((entry) => `${entry.host} (${entry.reason}, hop ${entry.hop})`)
            .join(", ")
        )
      }
      return {
        operationId,
        toolCallId: intent.id,
        name: intent.name,
        status: outcome.status,
        ...(outcome.refusalCode ? { refusalCode: outcome.refusalCode } : {}),
        evidence: outcome.evidence,
        summary: outcome.summary,
      }
    },
  }
}

/**
 * What a run may cite (DESIGN §9.3, INV-12, PAN-05): an artifact of THIS run —
 * stored by its own tools or given as its input — whose content window has not
 * passed and whose content still hashes to the reference. Another account's
 * artifact is in another database and is simply missing; another run's is
 * "not readable", whoever owns it.
 */
export function createRunEvidenceResolver(
  store: FusionLedgerStore,
  runId: string,
  now: () => number
): EvidenceResolver {
  return {
    async resolve(ref: EvidenceRef): Promise<EvidenceCheck> {
      const row = await store.db.fusionArtifacts.get(ref.artifact_id)
      if (!row) return { ok: false, reason: "missing" }
      if (row.runId !== runId) return { ok: false, reason: "not_readable" }
      if (row.expiresAt <= now()) return { ok: false, reason: "expired" }
      if (row.contentSha256 !== ref.content_sha256) return { ok: false, reason: "hash_mismatch" }
      try {
        // The row's hash is only a claim until the content is opened and hashed.
        const stored = await store.artifactStore(runId).get(ref.artifact_id)
        return stored ? { ok: true } : { ok: false, reason: "missing" }
      } catch {
        return { ok: false, reason: "hash_mismatch" }
      }
    },
  }
}
