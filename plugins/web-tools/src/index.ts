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
 */

import {
  defineContextProvider,
  wrapUntrustedContent,
  type PluginContext,
  type PluginDefinition,
  type PluginToolContext,
} from "@cognia/plugin-sdk"

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

interface ResearchArgs {
  query: string
  urls?: string[]
}

interface DownloadArgs {
  url: string
  filename?: string
  /**
   * Subfolder inside the plugin's data directory (desktop). Relative only —
   * absolute paths and `..` segments are rejected, never resolved.
   */
  directory?: string
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
function sanitizeFilename(name: string): string {
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
function sanitizeSubdir(raw: string): { ok: true; dir: string } | { ok: false; error: string } {
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

function pickConfig(ctx: PluginContext, key: string, fallback: string): string {
  const cfg = (ctx.config as Record<string, unknown> | undefined) ?? {}
  const value = cfg[key]
  return typeof value === "string" && value.length > 0 ? value : fallback
}

/**
 * Read a page through the host's promoted `web_fetch`.
 *
 * Goes through `ctx.agent.invokeTool` rather than the shared core directly:
 * that is the one door where the Settings kill switch, the SSRF guard, the
 * outbound rate limiter, the PII gate and this plugin's own
 * `networkAccess` clamp all run. Reaching into the core skipped every one of
 * them and forced this helper to re-implement the kill switch by hand.
 *
 * The `userAgent` plugin setting rides in as a header, which is exactly how
 * the core applied it (an explicit `args.headers` entry still wins). The tool
 * call's session/message/signal context is forwarded so the call bills the
 * right session on multi-session hosts and honours cancellation.
 */
async function webFetch(
  args: FetchArgs,
  ctx: PluginContext,
  callCtx?: PluginToolContext
): Promise<unknown> {
  if (!ctx.agent?.invokeTool) {
    return { ok: false as const, error: "host does not expose the Agent SDK (invokeTool)" }
  }
  const userAgent = pickConfig(ctx, "userAgent", "")
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (userAgent && !headers["User-Agent"]) headers["User-Agent"] = userAgent
  return ctx.agent.invokeTool(
    "web_fetch",
    { ...args, headers },
    {
      ...(callCtx?.signal ? { signal: callCtx.signal } : {}),
      ...(callCtx?.sessionId ? { sessionId: callCtx.sessionId } : {}),
      ...(callCtx?.messageId ? { messageId: callCtx.messageId } : {}),
    }
  )
}

async function webDownload(args: DownloadArgs, ctx: PluginContext): Promise<unknown> {
  if (!args.url || typeof args.url !== "string") {
    return { ok: false as const, error: "url is required" }
  }
  // The mobile WebView has no download manager: the anchor the browser
  // fallback synthesises is a dead click. Refuse explicitly so the model
  // learns the file was NOT saved instead of reporting a phantom success.
  if (ctx.capabilities.mobile) {
    return {
      ok: false as const,
      error: "web_download cannot save files from the mobile shell",
    }
  }

  const filename = sanitizeFilename(args.filename ?? basenameFromUrl(args.url))
  const rawDir = args.directory ?? pickConfig(ctx, "downloadDirectory", "")
  let dir = ""
  if (rawDir) {
    const scoped = sanitizeSubdir(rawDir)
    if (!scoped.ok) return { ok: false as const, error: scoped.error }
    dir = scoped.dir
  }
  const destPath = dir ? `${dir}/${filename}` : filename

  try {
    // `ctx.network.download`, not a manual `fetch` + `fs.writeFile`: the Rust
    // gateway streams the body as real BYTES into `<plugin>/data/<destPath>`
    // (`resolve_scoped` rejects traversal server-side), while the browser
    // fallback lands in the user's download folder. The old path fetched the
    // body as an `arraybuffer` — a type the gateway returns as a decoded
    // STRING — and wrote the result through `@tauri-apps/plugin-fs`, which
    // produced a 0-byte file outside every audited permission.
    const res = await ctx.network.download(args.url, destPath)
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
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * `web_research` — a dogfood of the plugin Agent SDK (ADR-0026 §Agent-SDK).
 * Exercises all four new surfaces in one real path:
 *   1. Shared `web_fetch` core via `invokeTool` — gather source text without
 *      registering another `web_fetch` tool or duplicating its
 *      SSRF/extraction/cache policy.
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
  args: ResearchArgs,
  ctx: PluginContext,
  callCtx?: PluginToolContext
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { ok: false as const, error: "query is required" }
  }
  const agent = ctx.agent
  if (!agent?.runStreamed) {
    return { ok: false as const, error: "host does not expose the Agent SDK (runStreamed)" }
  }

  // 1. Gather source text through the same first-class fetch core, distilled
  //    per-source against the query so long pages collapse to the relevant
  //    part instead of filling the corpus with boilerplate.
  const urls = Array.isArray(args.urls) ? args.urls.filter((u) => typeof u === "string") : []
  const gathered: Array<{ url: string; body: string }> = []
  const failed: Array<{ url: string; error: string }> = []
  for (const url of urls) {
    try {
      const fetched = (await webFetch({ url, maxBytes: 20_000, prompt: query }, ctx, callCtx)) as {
        ok?: boolean
        code?: string
        error?: string
        text?: string
        body?: string
      }
      // The kill switch is about the whole run, not this one URL: gathering
      // empty bodies from every source would answer from nothing and hide why.
      if (fetched?.code === "web-disabled") {
        return { ok: false as const, error: fetched.error ?? "Web tools are disabled in Settings." }
      }
      const body =
        typeof fetched?.text === "string"
          ? fetched.text
          : typeof fetched?.body === "string"
            ? fetched.body
            : ""
      if (fetched?.ok === false || !body) {
        failed.push({ url, error: fetched?.error ?? "no readable content" })
        continue
      }
      gathered.push({ url, body })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.(`web_research: fetch failed for ${url}: ${message}`)
      failed.push({ url, error: message })
    }
  }

  const corpus = gathered
    .map((g) => `# ${g.url}\n${g.body}`)
    .join("\n\n")
    .slice(0, 60_000)
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
  const run = agent.runStreamed(prompt, {
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
      onStop: (info) => ctx.logger?.info?.(`web_research finished on the ${info.channel} channel`),
    },
    // Package F — emit a per-run trace span.
    trace: true,
    ...(callCtx?.signal ? { abortSignal: callCtx.signal } : {}),
  })

  // Surface streamed deltas to the plugin log (best-effort) — a hiccup while
  // draining the delta stream must not abort an otherwise-fine run; the
  // authoritative outcome comes from `run.result` below.
  try {
    for await (const event of run) {
      if (event.type === "text-delta") ctx.logger?.info?.(event.delta)
    }
  } catch (err) {
    ctx.logger?.warn?.(
      `web_research stream logging error: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // `run.result` rejects on guardrail tripwires, the outbound PII gate and
  // provider failures — collapse those into the same `{ ok:false }` envelope
  // every other failure path in this plugin returns.
  let result
  try {
    result = await run.result
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }
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

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-web-tools",
    name: "Web Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "configuration"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("web-tools activated")

    if (!ctx.agent) {
      ctx.logger?.warn?.(
        "web-tools: host does not expose the Agent SDK — web_download and web_research are unavailable"
      )
      return
    }

    // Package E — register an ambient context provider so every agent run this
    // plugin starts knows the web tools are available without re-stating it.
    ctx.agent.context?.registerProvider?.(
      defineContextProvider({
        id: "web-tools:availability",
        name: "Web tools availability",
        // Speaks only for THIS plugin's tools. Whether the host's promoted
        // web_search / web_fetch can run is the host's own answer — it owns the
        // settings, and a plugin narrating them had to read the renderer store
        // to do it, which is both a layering break and a second copy of a
        // verdict that can drift from the one the tools actually enforce.
        provide: () =>
          "web_download saves a URL to disk; web_research summarizes one or more URLs into a cited answer.",
      })
    )

    ctx.agent.registerTool?.({
      name: "web_download",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_download",
        description:
          "Download a URL to disk. Desktop saves into the plugin's data folder (optional `directory` is a relative subfolder inside it); a plain browser triggers a download. Not supported on mobile.",
        parametersSchema: {
          type: "object",
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
      } as never,
      execute: (args) => webDownload((args ?? {}) as unknown as DownloadArgs, ctx),
    })

    ctx.agent.registerTool?.({
      name: "web_research",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_research",
        description:
          "Research a question over one or more URLs and return a structured summary with cited sources. May fetch follow-up pages.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The research question." },
            urls: {
              type: "array",
              items: { type: "string" },
              description: "Seed URLs to read first (optional — the run can fetch its own).",
            },
          },
          required: ["query"],
        },
      } as never,
      execute: (args, callCtx) =>
        webResearch((args ?? {}) as unknown as ResearchArgs, ctx, callCtx),
    })
  },
  deactivate: async () => {},
}

export default definition
