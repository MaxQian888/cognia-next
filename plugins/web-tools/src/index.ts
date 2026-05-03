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
import { isTauri } from "@/lib/tauri"

interface FetchArgs {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
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
    const text = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      url: args.url,
      headers: Object.fromEntries(res.headers.entries()),
      body: text.length > cap ? text.slice(0, cap) : text,
      truncated: text.length > cap,
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

    if (isTauri()) {
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

    ctx.agent?.registerTool?.({
      name: "web_fetch",
      pluginId: ctx.pluginId,
      definition: {
        name: "web_fetch",
        description: "Perform an HTTP request and return the response body as text.",
        parametersSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            method: { type: "string" },
            headers: { type: "object" },
            body: { type: "string" },
            maxBytes: { type: "number" },
          },
          required: ["url"],
        },
      } as never,
      execute: (args) => webFetch((args ?? {}) as FetchArgs, ctx),
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
      execute: (args) => webDownload((args ?? {}) as DownloadArgs, ctx),
    })
  },
  deactivate: async () => {
    // Tools are unregistered automatically by the runtime.
  },
}

export default definition
