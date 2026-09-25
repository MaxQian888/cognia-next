/**
 * Web Tools — built-in plugin.
 *
 * Two plugin-specific agent tools (`web_search` / `web_fetch` are promoted
 * host built-ins and are deliberately NOT re-registered here):
 *
 *   * `web_download` — fetch a URL and persist it through the host's
 *                      `ctx.network.download`. On Tauri the body streams
 *                      through the Rust gateway into the plugin's own
 *                      `data/` sandbox (traversal-safe server-side); on a
 *                      plain browser the host falls back to a click-through
 *                      anchor download; on the mobile shell the tool refuses
 *                      honestly instead of faking a save the WebView drops.
 *   * `web_research` — distill one or more URLs through `ctx.agent.invokeTool`
 *                      ("web_fetch"), then summarize the corpus as a streamed,
 *                      structured, PII-gated run that may itself call
 *                      `web_fetch` for follow-up pages.
 *
 * All egress goes through the plugin network API / promoted host tool, so the
 * manifest's `networkAccess` clamp, the SSRF guard, the rate limiter, the PII
 * gate and the audit ledger all apply. The manifest declares `network:fetch`
 * (fetch + download both ride that grant) and `agent:control` (invokeTool +
 * tool-enabled runs).
 *
 * Settings (`userAgent`, `downloadDirectory`) are read from the per-call
 * `callCtx.config`, never from `ctx.config`: the latter is a snapshot taken at
 * activation and would ignore a change the user made since.
 */

import {
  defineContextProvider,
  definePlugin,
  definePluginManifest,
  definePluginTool,
  wrapUntrustedContent,
  type PluginContext,
  type PluginToolContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

/** How `web_fetch` should present the response body. */
type FetchFormat = "auto" | "text" | "raw"

interface FetchArgs {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  /**
   * `auto` (default) extracts readable text for HTML responses and returns the
   * raw body for everything else; `text` forces extraction; `raw` skips it.
   */
  format?: FetchFormat
  /**
   * Query-focused extraction — the host distills the page to just the content
   * relevant to this question (far fewer tokens than the full page).
   */
  prompt?: string
  /** Read-window start for paging a long page (`nextOffset` from a prior call). */
  offset?: number
}

/**
 * `web_research` fetches up to this many seed URLs. Each read is a distilled
 * `web_fetch`; beyond a handful the corpus is truncated to `CORPUS_MAX_CHARS`
 * anyway, so more URLs only spend time and rate-limit budget.
 */
export const RESEARCH_MAX_URLS = 10
/** Seed pages read at once — small, so one call cannot saturate the rate limiter. */
export const RESEARCH_FETCH_CONCURRENCY = 3
/** Page reads plus a streamed, tool-enabled summarization run. */
export const WEB_RESEARCH_TIMEOUT_MS = 300_000
/** Large files stream through the Rust gateway; 30 s is far too short for them. */
export const WEB_DOWNLOAD_TIMEOUT_MS = 300_000
const PAGE_MAX_BYTES = 20_000
const CORPUS_MAX_CHARS = 60_000

type ToolFailure = { ok: false; error: string }

function failure(error: string): ToolFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "download.bin"
    return last
  } catch {
    return "download.bin"
  }
}

/**
 * Reduce a caller-supplied name to a single safe path segment. Model-provided
 * filenames are attacker-adjacent input: `../`, absolute paths and separator
 * tricks all collapse to the basename, control characters are stripped.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).filter(Boolean).pop() ?? ""
  // Strip C0 controls + DEL — filenames must be printable path segments.
  const clean = base.replace(/[\x00-\x1f\x7f]/g, "").trim()
  return clean === "" || clean === "." || clean === ".." ? "download.bin" : clean
}

/**
 * Validate `directory` as a sandbox-relative subfolder: `/abs`, `C:\…`,
 * empty segments and `..` are all rejected with an explicit error rather than
 * silently rewritten — the model sees exactly why the call was refused.
 */
export function sanitizeSubdir(
  raw: string
): { ok: true; dir: string } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: "directory is empty" }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) {
    return {
      ok: false,
      error:
        "directory must be relative — desktop downloads land inside the plugin's data folder, absolute paths are not writable",
    }
  }
  const parts = trimmed.split("/").map((p) => p.trim())
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) {
    return {
      ok: false,
      error: `directory "${raw}" is not a clean relative path (no "..", backslashes or empty segments)`,
    }
  }
  return { ok: true, dir: parts.join("/") }
}

/** A non-empty string setting from THIS call's config snapshot, else `fallback`. */
function callSetting(callCtx: PluginToolContext, key: string, fallback: string): string {
  const value = callCtx.config?.[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Map `items` through `fn` with at most `limit` in flight, keeping input order.
 * `shouldStop` is checked before each new item starts, so a cancelled call or
 * a run-wide refusal stops launching further work.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean = () => false
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined)
  let next = 0
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

/**
 * Read a page through the host's promoted `web_fetch`.
 *
 * Goes through `ctx.agent.invokeTool` rather than the shared core directly:
 * that is the one door where the Settings kill switch, the SSRF guard, the
 * outbound rate limiter, the PII gate and this plugin's own
 * `networkAccess` clamp all run.
 *
 * The `userAgent` setting rides in as a header (an explicit `args.headers`
 * entry still wins). The tool call's session/message/signal context is
 * forwarded so the call bills the right session on multi-session hosts and
 * honours cancellation.
 */
async function webFetch(
  args: FetchArgs,
  ctx: PluginContext,
  callCtx: PluginToolContext
): Promise<unknown> {
  const userAgent = callSetting(callCtx, "userAgent", "")
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (userAgent && !headers["User-Agent"]) headers["User-Agent"] = userAgent
  return ctx.agent.invokeTool(
    "web_fetch",
    { ...args, headers },
    {
      ...(callCtx.signal ? { signal: callCtx.signal } : {}),
      ...(callCtx.sessionId ? { sessionId: callCtx.sessionId } : {}),
      ...(callCtx.messageId ? { messageId: callCtx.messageId } : {}),
    }
  )
}

async function webDownload(
  args: Record<string, unknown>,
  ctx: PluginContext,
  callCtx: PluginToolContext
): Promise<unknown> {
  const url = optionalString(args.url)?.trim()
  if (!url) return failure("url is required")
  // The mobile WebView has no download manager: the anchor the browser
  // fallback synthesises is a dead click. Refuse explicitly so the model
  // learns the file was NOT saved instead of reporting a phantom success.
  if (ctx.capabilities.mobile) {
    return failure("web_download cannot save files from the mobile shell")
  }

  const filename = sanitizeFilename(optionalString(args.filename) ?? basenameFromUrl(url))
  const rawDir = optionalString(args.directory) ?? callSetting(callCtx, "downloadDirectory", "")
  let dir = ""
  if (rawDir) {
    const scoped = sanitizeSubdir(rawDir)
    if (!scoped.ok) return failure(scoped.error)
    dir = scoped.dir
  }
  const destPath = dir ? `${dir}/${filename}` : filename

  try {
    // `ctx.network.download`, not a manual `fetch` + `fs.writeFile`: the Rust
    // gateway streams the body as real BYTES into `<plugin>/data/<destPath>`
    // (`resolve_scoped` rejects traversal server-side), while the browser
    // fallback lands in the user's download folder.
    const res = await ctx.network.download(url, destPath)
    return {
      ok: true as const,
      path: res.path,
      bytes: res.size,
      ...(res.contentType ? { contentType: res.contentType } : {}),
      savedTo: ctx.capabilities.tauri
        ? ("plugin-data-dir" as const)
        : ("browser-download" as const),
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

interface FetchedPage {
  ok?: boolean
  code?: string
  error?: string
  text?: string
  body?: string
}

type PageOutcome =
  | { kind: "ok"; url: string; body: string }
  | { kind: "failed"; url: string; error: string }
  | { kind: "disabled"; error: string }

/**
 * `web_research` — a dogfood of the plugin Agent SDK (ADR-0026 §Agent-SDK):
 *   1. Shared `web_fetch` core via `invokeTool` — gather source text without
 *      registering another `web_fetch` tool or duplicating its
 *      SSRF/extraction/cache policy. Seed pages are read in parallel, at most
 *      `RESEARCH_FETCH_CONCURRENCY` at a time.
 *   2. `ctx.agent.runStreamed` — summarize the corpus as a live event stream.
 *   3. `outputFormat` — structured `{ summary, sources[] }` JSON output.
 *   4. PII redaction — applied by the host to every plugin run, so this tool
 *      does not (and cannot) opt out of it.
 *
 * The run is tool-enabled (`toolsEnabled` + `allowedTools: ["web_fetch"]`) so
 * the summarizer can pull follow-up pages itself; on hosts without the
 * sidecar it degrades to the text channel and `toolsAvailable` reports false.
 */
async function webResearch(
  args: Record<string, unknown>,
  ctx: PluginContext,
  callCtx: PluginToolContext
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) return failure("query is required")
  if (args.urls !== undefined && !Array.isArray(args.urls)) {
    return failure("urls must be an array of URL strings")
  }
  const urls = Array.from(
    new Set(
      ((args.urls as unknown[] | undefined) ?? [])
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter(Boolean)
    )
  )
  if (urls.length > RESEARCH_MAX_URLS) {
    return failure(
      `web_research reads at most ${RESEARCH_MAX_URLS} seed URLs per call (got ${urls.length}); pass the most relevant ones — the run can fetch follow-up pages itself`
    )
  }

  const signal = callCtx.signal
  const cancelled = () => failure("web_research was cancelled")
  if (signal?.aborted) return cancelled()

  // 1. Gather source text through the same first-class fetch core, distilled
  //    per-source against the query so long pages collapse to the relevant
  //    part instead of filling the corpus with boilerplate.
  let disabledError: string | null = null
  const outcomes = await mapWithConcurrency<string, PageOutcome>(
    urls,
    RESEARCH_FETCH_CONCURRENCY,
    async (url) => {
      try {
        const fetched = (await webFetch(
          { url, maxBytes: PAGE_MAX_BYTES, prompt: query },
          ctx,
          callCtx
        )) as FetchedPage | undefined
        // The kill switch is about the whole run, not this one URL: gathering
        // empty bodies from every source would answer from nothing and hide why.
        if (fetched?.code === "web-disabled") {
          disabledError = fetched.error ?? "Web tools are disabled in Settings."
          return { kind: "disabled", error: disabledError }
        }
        const body =
          typeof fetched?.text === "string"
            ? fetched.text
            : typeof fetched?.body === "string"
              ? fetched.body
              : ""
        if (fetched?.ok === false || !body) {
          return { kind: "failed", url, error: fetched?.error ?? "no readable content" }
        }
        return { kind: "ok", url, body }
      } catch (err) {
        const message = errorMessage(err)
        ctx.logger.warn(`web_research: fetch failed for ${url}: ${message}`)
        return { kind: "failed", url, error: message }
      }
    },
    () => disabledError !== null || signal?.aborted === true
  )
  if (disabledError !== null) return failure(disabledError)
  if (signal?.aborted) return cancelled()

  const gathered: Array<{ url: string; body: string }> = []
  const failed: Array<{ url: string; error: string }> = []
  for (const outcome of outcomes) {
    if (outcome?.kind === "ok") gathered.push({ url: outcome.url, body: outcome.body })
    else if (outcome?.kind === "failed") failed.push({ url: outcome.url, error: outcome.error })
  }

  const corpus = gathered
    .map((g) => `# ${g.url}\n${g.body}`)
    .join("\n\n")
    .slice(0, CORPUS_MAX_CHARS)
  // The fetch core moved its banner to a payload-level `untrustedNotice` that
  // this tool does not forward, so the frame has to be re-applied here: every
  // byte of `corpus` is attacker-controlled page text going into a tool-enabled
  // run. One frame for the whole block, matching how the core frames a payload.
  const prompt = corpus
    ? `Research question: ${query}\n\nSources:\n${wrapUntrustedContent(corpus)}`
    : `Research question: ${query}`

  // 2-4. Summarize as a structured, PII-gated, streaming run. `toolsEnabled`
  // + `allowedTools` are a pair — without the former the run lands on the
  // text channel and the allowlist silently does nothing.
  const run = ctx.agent.runStreamed(prompt, {
    appendSystem: "You are a precise research summarizer. Cite the source URLs you used.",
    toolsEnabled: true,
    allowedTools: ["web_fetch"],
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: { url: { type: "string" }, title: { type: "string" } },
            },
          },
        },
        required: ["summary"],
      },
    },
    // Package B — output guardrail: never return an empty summary.
    guardrails: [
      {
        id: "web-research:non-empty-summary",
        type: "output",
        run: ({ output }) => ({
          tripwireTriggered: output.trim().length === 0,
          message: "research produced an empty summary",
        }),
      },
    ],
    // Package A — onStop lifecycle hook (observability).
    hooks: {
      onStop: (info) => ctx.logger.debug(`web_research finished on the ${info.channel} channel`),
    },
    // Package F — emit a per-run trace span.
    trace: true,
    ...(signal ? { abortSignal: signal } : {}),
  })

  // Drain the event stream. Deltas go to the DEBUG log only — at info level a
  // long summary flooded the plugin log one token at a time. A hiccup while
  // draining must not abort an otherwise-fine run; the authoritative outcome
  // comes from `run.result` below.
  try {
    for await (const event of run) {
      if (event.type === "text-delta") ctx.logger.debug(event.delta)
    }
  } catch (err) {
    ctx.logger.warn(`web_research stream error: ${errorMessage(err)}`)
  }

  // `run.result` rejects on guardrail tripwires, the outbound PII gate,
  // cancellation and provider failures — collapse those into the same
  // `{ ok:false }` envelope every other failure path in this plugin returns.
  let result
  try {
    result = await run.result
  } catch (err) {
    return signal?.aborted ? cancelled() : failure(errorMessage(err))
  }

  return {
    ok: true as const,
    channel: result.channel,
    toolsAvailable: result.toolsAvailable,
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    object: result.object ?? null,
    // The raw summary text rides along so a structured-parse failure still
    // hands the model the answer instead of `object: null` alone.
    text: result.text,
    parseError: result.parseError ?? null,
    fetched: gathered.map((g) => g.url),
    ...(failed.length > 0 ? { failed } : {}),
  }
}

export const WEB_TOOL_NAMES = ["web_download", "web_research"] as const

function buildTools(ctx: PluginContext) {
  return [
    definePluginTool({
      name: "web_download",
      definition: {
        name: "web_download",
        description:
          "Download a URL to disk. Desktop saves into the plugin's data folder (optional `directory` is a relative subfolder inside it); a plain browser triggers a download. Not supported on mobile.",
        // Writes a file the user did not pick, from a URL the model chose.
        requiresApproval: true,
        timeoutMs: WEB_DOWNLOAD_TIMEOUT_MS,
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "The URL to download." },
            filename: {
              type: "string",
              description:
                "Filename to save as (basename only; derived from the URL when omitted).",
            },
            directory: {
              type: "string",
              description:
                "Optional relative subfolder inside the plugin's data directory (desktop only).",
            },
          },
          required: ["url"],
        },
      },
      execute: (args, callCtx) => webDownload(args, ctx, callCtx),
    }),
    definePluginTool({
      name: "web_research",
      definition: {
        name: "web_research",
        description: `Research a question over up to ${RESEARCH_MAX_URLS} URLs and return a structured summary with cited sources. May fetch follow-up pages.`,
        timeoutMs: WEB_RESEARCH_TIMEOUT_MS,
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "The research question." },
            urls: {
              type: "array",
              items: { type: "string" },
              maxItems: RESEARCH_MAX_URLS,
              description: `Seed URLs to read first, at most ${RESEARCH_MAX_URLS} (optional — the run can fetch its own).`,
            },
          },
          required: ["query"],
        },
      },
      execute: (args, callCtx) => webResearch(args, ctx, callCtx),
    }),
  ]
}

// plugin.json is the manifest source of truth; the tools register
// imperatively in `activate`.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: (ctx) => {
    // Package E — register an ambient context provider so every agent run this
    // plugin starts knows the web tools are available without re-stating it.
    ctx.agent.context.registerProvider(
      defineContextProvider({
        id: "web-tools:availability",
        name: "Web tools availability",
        // Speaks only for THIS plugin's tools. Whether the host's promoted
        // web_search / web_fetch can run is the host's own answer.
        provide: () =>
          "web_download saves a URL to disk; web_research summarizes one or more URLs into a cited answer.",
      })
    )
    for (const tool of buildTools(ctx)) ctx.agent.registerTool(tool)
    ctx.logger.info("web-tools activated")
  },
})
