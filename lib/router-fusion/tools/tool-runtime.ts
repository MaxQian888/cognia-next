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
 * Two policies:
 *  - `panel-read-1` — a candidate's one tool round: public pages, web search,
 *    and (when the run has a workspace the person at this device chose) files.
 *  - `panel-verify-1` — the judge's verification requests: re-read stored
 *    evidence, and re-fetch a page to check it still says the same thing.
 *    `compute` and `test` are not offered: a panel has no sandbox.
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
} from "@cognia/router-fusion"
import { z } from "zod"

import { persistableText, type FusionLedgerStore } from "../db/ledger-store"
import type { FusionToolOperationRow } from "../db/types"
import type { SsrfAuditEntry, WebEvidence } from "./web-evidence"
import type { WorkspaceReader, WorkspaceReadResult } from "./workspace-read"

export const PANEL_READ_POLICY = "panel-read-1"
export const PANEL_VERIFY_POLICY = "panel-verify-1"

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
} as const

type ToolName = keyof typeof Args

export interface HostToolRuntimeDeps {
  store: FusionLedgerStore
  runId: string
  web: WebEvidence | null
  workspace: WorkspaceReader | null
  now: () => number
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

export function createHostToolRuntime(deps: HostToolRuntimeDeps): ToolRuntime {
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
    }
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
      if (!offered) outcome = refused("TOOL_NOT_OFFERED")
      else if (offered.toolClass !== "read_only") outcome = refused("WRITE_NOT_PERMITTED")
      const parser = offered ? Args[offered.name as ToolName] : undefined
      const parsed = !outcome && parser ? parser.safeParse(intent.arguments) : null
      if (!outcome && !parsed?.success) outcome = refused("INVALID_ARGUMENTS")

      // A workspace read is the same operation only on the same content.
      let toolArgs: unknown = parsed?.success ? parsed.data : undefined
      if (!outcome && offered?.name === "workspace_read") {
        const read = await deps.workspace!.read((toolArgs as { path: string }).path)
        identity = { ...identity, content: read.ok ? read.contentSha256 : read.code }
        toolArgs = read
      }
      const operationId = canonicalHash(identity)
      const existing = await store.db.fusionToolOperations.get(operationId)
      if (existing) return receiptOf(existing, intent.id)

      outcome ??= await run(offered!.name as ToolName, toolArgs, context)
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
