/**
 * Web Tools — built-in plugin.
 *
 * Two plugin-specific agent tools:
 *   * `web_download` — fetch a URL and persist it locally. On Tauri we write
 *                      to `<configured downloadDirectory>/<filename>`; on
 *                      browsers we fall back to a click-through anchor.
 *   * `web_research` — summarize one or more URLs through the shared fetch core.
 *
 * Both routes go through `fetch`. The plugin manifest declares
 * `network:fetch` (always) and `filesystem:write` (optional, used only by
 * `web_download` when running on the desktop).
 */

import {
  defineContextProvider,
  wrapUntrustedContent,
  type PluginContext,
  type PluginDefinition,
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
}

interface ResearchArgs {
  query: string
  urls?: string[]
}

interface DownloadArgs {
  url: string
  filename?: string
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
 * the core applied it (an explicit `args.headers` entry still wins).
 */
async function webFetch(args: FetchArgs, ctx: PluginContext): Promise<unknown> {
  if (!ctx.agent?.invokeTool) {
    return { ok: false as const, error: "host does not expose the Agent SDK (invokeTool)" }
  }
  const userAgent = pickConfig(ctx, "userAgent", "")
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (userAgent && !headers["User-Agent"]) headers["User-Agent"] = userAgent
  return ctx.agent.invokeTool("web_fetch", { ...args, headers })
}

async function webDownload(args: DownloadArgs, ctx: PluginContext): Promise<unknown> {
  if (!args.url) {
    return { ok: false as const, error: "url is required" }
  }
  const filename = args.filename ?? basenameFromUrl(args.url)
  try {
    // `ctx.network.fetch`, not a bare `proxyFetch`: an agent-supplied download
    // URL is never on the packaged shell's `connect-src` allowlist, and the
    // plugin network API is the door that both routes around it (through the
    // Rust gateway when available) AND applies this plugin's egress policy —
    // `networkAccess.allowedDomains`, the PII outbound gate and the audit
    // trail. Reaching for the raw proxy skipped all three.
    const res = await ctx.network.fetch<ArrayBuffer>(args.url, { responseType: "arraybuffer" })
    if (!res.ok) {
      return { ok: false as const, error: `HTTP ${res.status}` }
    }
    const buffer = new Uint8Array(res.data)

    // ADR-0026 §5 §C. `capabilities` is part of `PluginHostContextAPI`, which
    // `PluginContext` intersects unconditionally, so it is always wired — the
    // old `?? isTauri()` fallback was reaching into `@/lib/tauri` for an answer
    // the context already guarantees.
    if (ctx.capabilities.tauri) {
      const directory = args.directory ?? pickConfig(ctx, "downloadDirectory", "")
      if (!directory) {
        return {
          ok: false as const,
          error:
            "downloadDirectory is not configured. Set it in the plugin's settings or pass `directory` in the call.",
        }
      }
      const fs = await import("@tauri-apps/plugin-fs")
      const target = `${directory.replace(/\/$/, "")}/${filename}`
      await fs.writeFile(target, buffer)
      return {
        ok: true as const,
        path: target,
        bytes: buffer.byteLength,
      }
    }

    // Browser fallback — kick off a download via an anchor element.
    const blob = new Blob([buffer])
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return { ok: true as const, downloadedAs: filename, bytes: buffer.byteLength }
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
 *   1. Shared `webFetch` core — gather source text without registering another
 *      `web_fetch` tool or duplicating its SSRF/extraction/cache policy.
 *   2. `ctx.agent.runStreamed` — summarize the corpus as a live event stream.
 *   3. `outputFormat` — structured `{ summary, sources[] }` JSON output.
 *   4. PII redaction — applied by the host to every plugin run, so this tool
 *      does not (and cannot) opt out of it.
 */
async function webResearch(args: ResearchArgs, ctx: PluginContext): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { ok: false as const, error: "query is required" }
  }
  const agent = ctx.agent
  if (!agent?.runStreamed) {
    return { ok: false as const, error: "host does not expose the Agent SDK (runStreamed)" }
  }

  // 1. Gather source text through the same first-class fetch core.
  const urls = Array.isArray(args.urls) ? args.urls.filter((u) => typeof u === "string") : []
  const gathered: Array<{ url: string; body: string }> = []
  for (const url of urls) {
    try {
      const fetched = (await webFetch({ url, maxBytes: 20_000 }, ctx)) as {
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
      gathered.push({ url, body })
    } catch (err) {
      ctx.logger?.warn?.(`web_research: fetch failed for ${url}: ${String(err)}`)
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

  // 2-4. Summarize as a structured, PII-gated, streaming run.
  const run = agent.runStreamed(prompt, {
    appendSystem: "You are a precise research summarizer. Cite the source URLs you used.",
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

  const result = await run.result
  return {
    ok: true as const,
    channel: result.channel,
    object: result.object ?? null,
    parseError: result.parseError ?? null,
    fetched: gathered.map((g) => g.url),
  }
}

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-web-tools",
    name: "Web Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("web-tools activated")

    // Package E — register an ambient context provider so every agent run this
    // plugin starts knows the web tools are available without re-stating it.
    ctx.agent?.context?.registerProvider?.(
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

    ctx.agent?.registerTool?.({
      name: "web_download",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_download",
        description: "Download a URL to disk (desktop) or trigger a browser download.",
        parametersSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            filename: { type: "string" },
            directory: { type: "string" },
          },
          required: ["url"],
        },
      } as never,
      execute: (args) => webDownload((args ?? {}) as unknown as DownloadArgs, ctx),
    })

    ctx.agent?.registerTool?.({
      name: "web_research",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_research",
        description:
          "Research a question over one or more URLs and return a structured summary with cited sources.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            urls: { type: "array", items: { type: "string" } },
          },
          required: ["query"],
        },
      } as never,
      execute: (args) => webResearch((args ?? {}) as unknown as ResearchArgs, ctx),
    })
  },
  deactivate: async () => {},
}

export default definition
