/**
 * GitHub `PlatformAdapter` — outbound side of the Inbox bridge.
 *
 * The inbox-bridge already surfaces GitHub events as connector cards; this
 * adapter completes the loop so cognia users can reply from the composer or
 * approve HITL drafts and have those replies post back to GitHub as real
 * comments / reviews / merges. Routing through `lib/connectors/bus`'s
 * outbound queue means GitHub replies inherit the platform's existing
 * quiet-hours / circuit-breaker / idempotency machinery for free.
 *
 * Inbound is intentionally NOT wired here — events arrive via webhook +
 * polling (the existing `runGithubPoll` + Rust webhook router), and the
 * plugin entry hands them to `bus.dispatchInboundFull`. The adapter's
 * `start` is a no-op for the same reason.
 */

import type { Octokit } from "@octokit/core"
import type { MessageSegment } from "@/types/connectors/segment"
import type {
  AdapterContext,
  AdapterHealth,
  AdapterMeta,
  PlatformAdapter,
} from "@/types/connectors/adapter"
import type { OutboundError, OutboundRequest, OutboundResult } from "@/types/connectors/outbound"
import { buildA2UICapabilityMatrix, type A2UICapabilityMatrix } from "@/types/connectors/capability"
import {
  GITHUB_ADAPTER_ID,
  type GhConversationCoords,
  decodeConversationKey,
} from "./conversation-key"

export const GITHUB_ADAPTER_META: AdapterMeta = {
  type: "github",
  displayName: "GitHub",
  version: "1.0.0",
  capabilities: ["send.text", "send.markdown"],
  transportModes: ["webhook"],
  // No configurable settings — credentials live on the GhRepoEntry rows
  // configured under Settings → GitHub Delivery → Credentials.
  configSchema: { type: "object", properties: {}, additionalProperties: false },
}

/**
 * GitHub renders Markdown-rich comments natively; A2UI surfaces all
 * degrade to `plainTextMirror` which becomes the comment body via
 * `extractText(req.segments)`. No interactive A2UI components are
 * available because GitHub issue/PR comments have no button or form
 * affordance — only Markdown.
 */
export const GITHUB_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({})

export interface GithubAdapterDeps {
  /** Resolve an octokit instance for a fully-qualified repo name. */
  getOctokit: (repoFullName: string) => Promise<Octokit>
  /** Optional clock — exposed for deterministic tests. */
  now?: () => number
}

export class GithubAdapter implements PlatformAdapter {
  readonly meta: AdapterMeta = GITHUB_ADAPTER_META
  readonly id: string

  private deps: GithubAdapterDeps
  private health_: AdapterHealth = { state: "starting" }

  constructor(id: string, deps: GithubAdapterDeps) {
    this.id = id
    this.deps = deps
  }

  async start(_ctx: AdapterContext): Promise<void> {
    this.health_ = { state: "running", lastActivityAt: (this.deps.now ?? Date.now)() }
  }

  async stop(): Promise<void> {
    this.health_ = { state: "down" }
  }

  health(): AdapterHealth {
    return this.health_
  }

  a2uiCapability(): A2UICapabilityMatrix {
    return GITHUB_A2UI_CAPABILITY
  }

  async send(req: OutboundRequest): Promise<OutboundResult> {
    const coords = resolveCoords(req)
    if (!coords) {
      return errorResult(
        "validation",
        "GitHub send: conversationRef must carry repoFullName + refKind/refNumber, " +
          "or a valid conversationKey produced by `encodeConversationKey`.",
        false
      )
    }
    const body = extractText(req.segments)
    if (!body.trim()) {
      return errorResult("validation", "GitHub send: empty body — nothing to post", false)
    }
    try {
      const octokit = await this.deps.getOctokit(`${coords.owner}/${coords.repo}`)
      // Both PR and Issue comments hit the same /issues/{n}/comments
      // endpoint (PRs are issues from GitHub's API perspective). Reviews
      // — body + line-anchored comments — go through the workflow node
      // `action.github.reviewPrInline` instead.
      const { data } = (await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: coords.owner,
          repo: coords.repo,
          issue_number: coords.number,
          body,
        }
      )) as { data: { id: number; node_id?: string } }
      this.health_ = {
        state: "running",
        lastActivityAt: (this.deps.now ?? Date.now)(),
      }
      return { ok: true, platformMessageId: String(data.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.health_ = {
        state: "degraded",
        reason: message,
        lastActivityAt: (this.deps.now ?? Date.now)(),
      }
      const transient = /5\d\d|fetch failed|ETIMEDOUT|ECONNRESET/i.test(message)
      return errorResult(transient ? "platform_5xx" : "platform_4xx", message, transient)
    }
  }
}

export function createGithubAdapter(deps: GithubAdapterDeps): (id: string) => GithubAdapter {
  return (id: string) => new GithubAdapter(id || GITHUB_ADAPTER_ID, deps)
}

function resolveCoords(req: OutboundRequest): GhConversationCoords | null {
  // Prefer the conversationKey when present — it round-trips through the
  // same helper the inbox-bridge uses, so we know it's well-formed.
  const fromKey = decodeFromKey(req)
  if (fromKey) return fromKey

  // Fall back to the typed fields on ConversationReference that the
  // inbox-bridge populates.
  const ref = req.conversationRef as Record<string, unknown>
  const repoFullName = typeof ref.repoFullName === "string" ? ref.repoFullName : null
  const refKind = ref.refKind === "pr" || ref.refKind === "issue" ? ref.refKind : null
  const refNumber = typeof ref.refNumber === "number" ? ref.refNumber : null
  if (!repoFullName || !refKind || refNumber === null) return null
  const slashAt = repoFullName.indexOf("/")
  if (slashAt <= 0) return null
  return {
    owner: repoFullName.slice(0, slashAt),
    repo: repoFullName.slice(slashAt + 1),
    kind: refKind,
    number: refNumber,
  }
}

function decodeFromKey(req: OutboundRequest): GhConversationCoords | null {
  const meta = req.conversationRef as Record<string, unknown>
  // The outbound queue carries the conversationKey on the metadata object
  // (see lib/db/outbound-jobs schema). Inspect both common slots.
  const candidates: unknown[] = [
    (req.metadata as unknown as { conversationKey?: unknown }).conversationKey,
    meta.conversationKey,
  ]
  for (const c of candidates) {
    if (typeof c === "string") {
      const coords = decodeConversationKey(c)
      if (coords) return coords
    }
  }
  return null
}

function extractText(segments: MessageSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === "text") return seg.text
      if (seg.type === "markdown") return seg.md
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function errorResult(
  code: OutboundError["code"],
  message: string,
  retryable: boolean
): OutboundResult {
  return { ok: false, error: { code, message, retryable } }
}
