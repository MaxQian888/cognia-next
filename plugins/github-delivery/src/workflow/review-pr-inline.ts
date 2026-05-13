/**
 * PR Inline Review agent — upgrade of the seed "PR auto-review" template.
 *
 * The original template chained `ai.prompt` → `action.github.commentPr`,
 * which produced one bulk comment per PR. This module ships a richer flow:
 *
 *   1. Fetch the PR's changed files (max `maxFiles`, capped at 30).
 *   2. Concatenate the patch slices into a single review prompt.
 *   3. Ask the LLM (via `createLlmClient` — same provider router the rest
 *      of cognia uses) to emit STRICT JSON:
 *
 *      { "body": "high-level summary",
 *        "comments": [{ "path": "...", "line": 12, "side": "RIGHT", "body": "…" }, …] }
 *
 *   4. Post the review via Octokit's `POST /pulls/{n}/reviews` with event
 *      = COMMENT (non-blocking) and the inline `comments` array.
 *
 * The agent runs as a single LLM call — no sub-process, no workspace
 * clone — because PR review is a read-only analysis pass over the diff
 * the GitHub API hands us. Long-form sidecar driver involvement is
 * reserved for the Issue → PR loop (write path).
 */

import type { Octokit } from "@octokit/core"

export interface InlineReviewComment {
  path: string
  line: number
  side?: "LEFT" | "RIGHT"
  body: string
}

export interface RunPRReviewAgentParams {
  repoFullName: string
  prNumber: number
  /** Maximum files inspected per review. Hard-capped at 30. */
  maxFiles?: number
  /** Free-text focus (e.g., "security", "performance"). Optional. */
  focus?: string
  /** LLM credentials — mirror `ai.prompt`. */
  provider: string
  model: string
  apiKey: string
  baseURL?: string
}

export interface RunPRReviewAgentResult {
  reviewId: number
  body: string
  commentCount: number
  filesAnalysed: number
  /** True when the LLM produced parsable JSON; false ⇒ we posted body only. */
  parsedStructured: boolean
}

export interface PRReviewAgentHooks {
  /** Override the LLM client factory — defaults to `lib/twin/distill/llm`. */
  createLlmClient?: typeof import("@/lib/twin/distill/llm").createLlmClient
}

const MAX_FILES_HARD_CAP = 30

export async function runPRReviewAgent(
  params: RunPRReviewAgentParams,
  octokit: Octokit,
  hooks: PRReviewAgentHooks = {}
): Promise<RunPRReviewAgentResult> {
  const maxFiles = Math.max(1, Math.min(MAX_FILES_HARD_CAP, params.maxFiles ?? 5))
  const { owner, repo } = splitRepo(params.repoFullName)

  // 1. Fetch changed files (Octokit caps at 300 per page; one page is plenty
  //    since maxFiles ≤ 30).
  const filesResp = (await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
    owner,
    repo,
    pull_number: params.prNumber,
    per_page: maxFiles,
  })) as { data: Array<{ filename: string; patch?: string; status: string }> }
  const files = filesResp.data.slice(0, maxFiles)

  // 2. Build the prompt. We deliberately keep the diff slice short per file
  //    (1500 chars) so the request fits in a single completion call even
  //    when maxFiles is large.
  const diffPayload = files
    .map((f) => {
      const trimmed = (f.patch ?? "").slice(0, 1500)
      return `### FILE: ${f.filename} (${f.status})\n\`\`\`diff\n${trimmed}\n\`\`\``
    })
    .join("\n\n")
  const focusLine = params.focus?.trim() ? `Specific focus: ${params.focus.trim()}\n\n` : ""
  const systemPrompt = [
    "You are a senior code reviewer. Inspect the unified diff below and",
    "produce a JSON response (and ONLY JSON, no markdown fences) of shape:",
    `{ "body": "<one-paragraph overall summary>",`,
    `  "comments": [{ "path": "<file>", "line": <int>, "side": "RIGHT", "body": "<actionable inline comment>" }] }`,
    "",
    "Rules:",
    "  • `line` must point at a line that exists on the right side of the diff.",
    "  • Skip trivial whitespace / style noise.",
    "  • Maximum 8 inline comments. Pick the highest-signal findings.",
    "  • If you have no findings, return an empty `comments` array.",
  ].join("\n")
  const userPrompt = `${focusLine}${diffPayload}`

  const factory = hooks.createLlmClient ?? (await import("@/lib/twin/distill/llm")).createLlmClient
  const client = factory({
    provider: params.provider as Parameters<typeof factory>[0]["provider"],
    model: params.model,
    apiKey: params.apiKey,
    baseURL: params.baseURL,
  })
  const completion = await client.complete(userPrompt, { system: systemPrompt })

  const parsed = tryParseReviewJson(completion)
  const body = parsed?.body?.trim() || stripFences(completion).trim()
  const comments: InlineReviewComment[] = (parsed?.comments ?? []).slice(0, 8)

  // 3. Post the review with inline comments. Octokit accepts an empty
  //    comments array — review-only mode.
  const review = (await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner,
    repo,
    pull_number: params.prNumber,
    event: "COMMENT",
    body,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.body,
    })),
  })) as { data: { id: number } }

  return {
    reviewId: review.data.id,
    body,
    commentCount: comments.length,
    filesAnalysed: files.length,
    parsedStructured: parsed !== null,
  }
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/")
  if (!owner || !repo) throw new Error(`bad repo full name "${fullName}"`)
  return { owner, repo }
}

export function tryParseReviewJson(
  raw: string
): { body?: string; comments?: InlineReviewComment[] } | null {
  if (!raw) return null
  const text = stripFences(raw).trim()
  // Find the largest balanced { … } slice. The simplest robust heuristic:
  // match the first '{' to the LAST '}' in the string.
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      body?: unknown
      comments?: unknown
    }
    const body = typeof parsed.body === "string" ? parsed.body : undefined
    const comments: InlineReviewComment[] = []
    if (Array.isArray(parsed.comments)) {
      for (const c of parsed.comments) {
        if (!c || typeof c !== "object") continue
        const obj = c as Record<string, unknown>
        if (
          typeof obj.path === "string" &&
          typeof obj.line === "number" &&
          typeof obj.body === "string"
        ) {
          comments.push({
            path: obj.path,
            line: obj.line,
            side: obj.side === "LEFT" ? "LEFT" : "RIGHT",
            body: obj.body,
          })
        }
      }
    }
    return { body, comments }
  } catch {
    return null
  }
}

function stripFences(s: string): string {
  return s.replace(/```(?:json)?\n?/gi, "").replace(/```/g, "")
}
