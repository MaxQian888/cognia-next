/**
 * Web Tools — built-in plugin.
 *
 * Two agent tools:
 *   * `web_fetch`    — perform an HTTP GET (or other method) and return the
 *                      response body as text. Bounded at 256 KB by default.
 *   * `web_download` — fetch a URL and persist it locally. On Tauri we write
 *                      to `<configured downloadDirectory>/<filename>`; on
 *                      browsers we fall back to a click-through anchor.
 *
 * Both routes go through `fetch`. The plugin manifest declares
 * `network:fetch` (always) and `filesystem:write` (optional, used only by
 * `web_download` when running on the desktop).
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
// `isTauri` retained as fallback when host doesn't expose
// `ctx.capabilities` (ADR-0026 §5 §C migration path).
import { isTauri } from "@/lib/tauri"
import { createPiiRedactionGate, defineContextProvider } from "@/lib/plugin/sdk"
// Reuse the app's existing infrastructure rather than reimplementing:
//   * multi-provider web search → `lib/search/search-service`
//   * readable HTML → text extraction → `lib/document/parsers/html-parser`
//   * the user's configured providers/keys → the settings store
import { search, formatSearchResultsForLLM } from "@/lib/search/search-service"
import {
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
  isProviderConfigured,
  type SearchProviderType,
} from "@/lib/search/types"
import { parseHTML } from "@/lib/document/parsers/html-parser"
import { useSettingsStore } from "@/stores/settings"

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

interface SearchArgs {
  query: string
  /** Force a specific provider; defaults to the user's configured default. */
  provider?: SearchProviderType
  maxResults?: number
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

const DEFAULT_MAX = 256 * 1024

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

async function webFetch(args: FetchArgs, ctx: PluginContext): Promise<unknown> {
  if (!args.url) {
    return { ok: false as const, error: "url is required" }
  }
  const userAgent = pickConfig(ctx, "userAgent", "")
  const headers: Record<string, string> = { ...(args.headers ?? {}) }
  if (userAgent && !headers["User-Agent"]) headers["User-Agent"] = userAgent
  try {
    const res = await fetch(args.url, {
      method: args.method ?? "GET",
      headers,
      body: args.body,
    })
    const cap = args.maxBytes && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX
    const raw = await res.text()
    const body = raw.length > cap ? raw.slice(0, cap) : raw
    const contentType = res.headers.get?.("content-type") ?? ""
    const format: FetchFormat = args.format ?? "auto"
    // Readable extraction: HTML pages are mostly markup the model shouldn't have
    // to wade through, so for HTML responses we add a clean `text` (+ `title`)
    // alongside the raw `body`. Reuses the app's cheerio-based parser.
    const wantsExtract = format !== "raw" && (format === "text" || /html/i.test(contentType))
    let extracted: { text: string; title?: string } | undefined
    if (wantsExtract && res.ok && raw) {
      try {
        const parsed = await parseHTML(raw, { includeLinks: false, includeImages: false })
        const text = parsed.text?.trim() ?? ""
        if (text) {
          extracted = {
            text: text.length > cap ? text.slice(0, cap) : text,
            ...(parsed.title ? { title: parsed.title } : {}),
          }
        }
      } catch {
        // Malformed HTML — fall back to the raw body the caller still receives.
      }
    }
    return {
      ok: res.ok,
      status: res.status,
      url: args.url,
      headers: Object.fromEntries(res.headers.entries()),
      body,
      truncated: raw.length > cap,
      ...(extracted ? { text: extracted.text, title: extracted.title } : {}),
    }
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * `web_search` — multi-provider web search over the user's configured providers
 * (Tavily, Brave, Exa, Google, Perplexity, …). Delegates entirely to the app's
 * unified `lib/search` service — provider selection, fallback, caching, and
 * usage accounting all come for free; this tool only adapts the call to the
 * agent boundary (reads provider settings, formats the response for the model).
 */
async function webSearch(args: SearchArgs, _ctx: PluginContext): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { ok: false as const, error: "query is required" }
  }
  const settings = useSettingsStore.getState().settings
  const providerSettings = settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  const configured = Object.values(providerSettings).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  )
  if (configured.length === 0) {
    return {
      ok: false as const,
      error:
        "No web search provider is configured. Enable one and add its API key in Settings → Search.",
    }
  }
  try {
    const response = await search(query, {
      providerSettings,
      ...(args.provider ? { provider: args.provider } : {}),
      ...(typeof args.maxResults === "number" ? { maxResults: args.maxResults } : {}),
      ...(typeof settings?.searchMaxResults === "number" && args.maxResults == null
        ? { maxResults: settings.searchMaxResults }
        : {}),
      fallbackEnabled: settings?.searchFallbackEnabled ?? true,
    })
    return {
      ok: true as const,
      query,
      provider: response.provider,
      answer: response.answer ?? null,
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      })),
      // A ready-to-read block the model can cite directly.
      formatted: formatSearchResultsForLLM(response),
    }
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function webDownload(args: DownloadArgs, ctx: PluginContext): Promise<unknown> {
  if (!args.url) {
    return { ok: false as const, error: "url is required" }
  }
  const filename = args.filename ?? basenameFromUrl(args.url)
  try {
    const res = await fetch(args.url)
    if (!res.ok) {
      return { ok: false as const, error: `HTTP ${res.status}` }
    }
    const buffer = new Uint8Array(await res.arrayBuffer())

    // Prefer ADR-0026 §5 §C `ctx.capabilities.tauri`; fall back to the
    // direct `isTauri()` call when the host doesn't expose it.
    const tauriHost = ctx.capabilities?.tauri ?? isTauri()
    if (tauriHost) {
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
 *   1. `ctx.agent.invokeTool` — reuse this plugin's own `web_fetch` tool by
 *      name to gather source text (no fetch duplication).
 *   2. `ctx.agent.runStreamed` — summarize the corpus as a live event stream.
 *   3. `outputFormat` — structured `{ summary, sources[] }` JSON output.
 *   4. `canUseTool` — the PII-redaction gate rewrites tool-call arguments
 *      (exercised live when the run is tool-enabled on the desktop sidecar).
 */
async function webResearch(args: ResearchArgs, ctx: PluginContext): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { ok: false as const, error: "query is required" }
  }
  const agent = ctx.agent
  if (!agent?.invokeTool || !agent?.runStreamed) {
    return { ok: false as const, error: "host does not expose the Agent SDK (run/invokeTool)" }
  }

  // 1. Gather source text via the plugin's OWN web_fetch tool (invokeTool seam).
  const urls = Array.isArray(args.urls) ? args.urls.filter((u) => typeof u === "string") : []
  const gathered: Array<{ url: string; body: string }> = []
  for (const url of urls) {
    try {
      const fetched = (await agent.invokeTool("web_fetch", { url, maxBytes: 20_000 })) as {
        body?: string
      }
      gathered.push({ url, body: typeof fetched?.body === "string" ? fetched.body : "" })
    } catch (err) {
      ctx.logger?.warn?.(`web_research: fetch failed for ${url}: ${String(err)}`)
    }
  }

  const corpus = gathered
    .map((g) => `# ${g.url}\n${g.body}`)
    .join("\n\n")
    .slice(0, 60_000)
  const prompt = corpus
    ? `Research question: ${query}\n\nSources:\n${corpus}`
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
    canUseTool: createPiiRedactionGate(),
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

  // Surface streamed deltas to the plugin log (best-effort).
  for await (const event of run) {
    if (event.type === "text-delta") ctx.logger?.info?.(event.delta)
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
        provide: () =>
          "Web tools are available: web_search (multi-provider web search), web_fetch (HTTP GET + readable text extraction), web_download, web_research.",
      })
    )

    ctx.agent?.registerTool?.({
      name: "web_search",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_search",
        description:
          "Search the web via the user's configured provider (Tavily/Brave/Exa/Google/…) and return ranked results with an optional AI answer.",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            provider: { type: "string" },
            maxResults: { type: "number" },
          },
          required: ["query"],
        },
      } as never,
      execute: (args) => webSearch((args ?? {}) as unknown as SearchArgs, ctx),
    })

    ctx.agent?.registerTool?.({
      name: "web_fetch",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_fetch",
        description:
          "Perform an HTTP request and return the response body. For HTML pages, also returns readable extracted `text` and the page `title`.",
        parametersSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            method: { type: "string" },
            headers: { type: "object" },
            body: { type: "string" },
            maxBytes: { type: "number" },
            format: { type: "string", enum: ["auto", "text", "raw"] },
          },
          required: ["url"],
        },
      } as never,
      execute: (args) => webFetch((args ?? {}) as unknown as FetchArgs, ctx),
    })

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
  deactivate: async () => {
    // Tools are unregistered automatically by the runtime.
  },
}

export default definition
