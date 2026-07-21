/**
 * Glue between the host `PluginContext` and the decoupled engine `EngineDeps`.
 * Resolves the host model bridge (`ctx.ai`) and a self-contained search/read
 * provider (own API key), returning a friendly error code when prerequisites
 * are missing so the tool/slash surfaces can explain what to configure.
 */
import type { PluginContext } from "@/types/plugin"
import type { AiBridge } from "./lib/ai"
import { readApiKey, readSearchProvider } from "./config"
import { makeReadFn, makeSearchFn, type FetchLike } from "./providers/search"
import type { EngineDeps } from "./types"

/**
 * Adapt `ctx.network` to the providers' `FetchLike` seam.
 *
 * A bare `globalThis.fetch` to `https://api.exa.ai` is BLOCKED in the desktop
 * shell: `src-tauri/tauri.conf.json` sets
 * `connect-src 'self' ipc: http://ipc.localhost ws: wss:` — no `https:` — so
 * the request never leaves the renderer. `ctx.network` routes through the Rust
 * gateway (reqwest) when it is available, which is not subject to the page CSP,
 * and falls back to browser `fetch` when it is not. It also enforces
 * `manifest.networkAccess.allowedDomains`, the sole egress check in web/mobile.
 */
export function networkFetch(ctx: PluginContext): FetchLike | undefined {
  const network = (
    ctx as unknown as {
      network?: {
        fetch?: (
          url: string,
          options?: {
            method?: string
            headers?: Record<string, string>
            body?: unknown
            responseType?: string
          }
        ) => Promise<{ ok: boolean; status: number; data: unknown }>
      }
    }
  ).network
  if (typeof network?.fetch !== "function") return undefined

  return async (url, init) => {
    // Ask for text and parse here: the host's "json" mode sniffs content-type
    // and silently hands back a string for a mislabelled response, which would
    // make `json()` return a string instead of an object.
    const res = await network.fetch!(url, {
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      responseType: "text",
    })
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? null)
    return {
      ok: res.ok,
      status: res.status,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    }
  }
}

/**
 * The activate context is typed as `PluginContext`, but the host wires the
 * extended `ai` namespace at runtime (`createFullPluginContext`). Read it
 * defensively so we stay type-safe without importing `@/lib/plugin`.
 */
export function getAiBridge(ctx: PluginContext): AiBridge | null {
  const ai = (ctx as unknown as { ai?: Partial<AiBridge> }).ai
  if (ai && typeof ai.chat === "function" && typeof ai.embed === "function") {
    return ai as AiBridge
  }
  return null
}

export interface BuildDepsOptions {
  reportProgress?: (progress: number, message?: string) => void
  signal?: AbortSignal
}

export type BuildDepsResult =
  | { ok: true; deps: EngineDeps }
  | { ok: false; error: "NO_PROVIDER" | "MISSING_KEY" | "NO_AI_PERMISSION"; provider?: string }

/**
 * The API permissions `ctx.ai.chat` / `ctx.ai.embed` are gated behind.
 *
 * These are `PluginAPIPermission`s, NOT manifest permissions — they are absent
 * from both the `PluginPermission` union and the SDK contract catalog, so they
 * cannot be declared in `plugin.json`. `createApiGuardedAPI` fails CLOSED, and
 * the only grants a plugin gets for free are `notification:show` + `theme:read`.
 * `ctx.permissions.requestPermission` (which takes exactly a
 * `PluginAPIPermission`) is the sanctioned way to obtain them.
 *
 * Without this the engine threw a raw `PermissionError` on its first model call
 * — every research run failed, and the friendly `NO_PROVIDER` card never showed
 * because `getAiBridge` only probes that `chat`/`embed` are functions, and the
 * guard Proxy *is* a function.
 */
const REQUIRED_AI_PERMISSIONS = ["ai:chat", "ai:embed"] as const

const AI_PERMISSION_REASON =
  "Deep Research drives the research loop with the app's configured model: it rewrites queries, judges sources, and drafts the final answer."

/**
 * Ensure both AI permissions are granted, prompting the user once if needed.
 * Returns false when the host exposes no permission API (older context) or the
 * user declines — the caller then reports `NO_AI_PERMISSION` instead of letting
 * a `PermissionError` escape mid-run.
 */
async function ensureAiPermissions(ctx: PluginContext): Promise<boolean> {
  const permissions = (
    ctx as unknown as {
      permissions?: {
        hasPermission?: (p: string) => boolean
        requestPermission?: (p: string, reason?: string) => Promise<boolean>
      }
    }
  ).permissions
  // No permission API on this context: fall through and let the call itself
  // fail rather than blocking a host that doesn't gate these.
  if (!permissions?.hasPermission || !permissions.requestPermission) return true

  for (const permission of REQUIRED_AI_PERMISSIONS) {
    if (permissions.hasPermission(permission)) continue
    const granted = await permissions.requestPermission(permission, AI_PERMISSION_REASON)
    if (!granted) return false
  }
  return true
}

export async function buildEngineDeps(
  ctx: PluginContext,
  options: BuildDepsOptions = {}
): Promise<BuildDepsResult> {
  const ai = getAiBridge(ctx)
  if (!ai) return { ok: false, error: "NO_PROVIDER" }

  if (!(await ensureAiPermissions(ctx))) return { ok: false, error: "NO_AI_PERMISSION" }

  const provider = readSearchProvider(ctx)
  const apiKey = await readApiKey(ctx, provider)
  if (!apiKey) return { ok: false, error: "MISSING_KEY", provider }

  // Undefined on a context without `network` — the providers then fall back to
  // `globalThis.fetch`, which is correct in a plain browser and is all the old
  // behavior ever did.
  const fetchImpl = networkFetch(ctx)

  const deps: EngineDeps = {
    ai,
    search: makeSearchFn({ provider, apiKey, fetchImpl }),
    read: makeReadFn({ provider, apiKey, fetchImpl }),
    logger: {
      info: (msg, ...args) => ctx.logger?.info?.(msg, ...args),
      warn: (msg, ...args) => ctx.logger?.warn?.(msg, ...args),
    },
    reportProgress: options.reportProgress,
    signal: options.signal,
  }
  return { ok: true, deps }
}
