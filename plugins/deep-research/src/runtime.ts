/**
 * Glue between the host `PluginContext` and the decoupled engine `EngineDeps`.
 * Resolves the host model bridge (`ctx.ai`) and a self-contained search/read
 * provider (own API key), returning a friendly error code when prerequisites
 * are missing so the tool/slash surfaces can explain what to configure.
 */
import type { PluginContext } from "@/types/plugin"
import type { AiBridge } from "./lib/ai"
import { readApiKey, readSearchProvider } from "./config"
import { makeReadFn, makeSearchFn } from "./providers/search"
import type { EngineDeps } from "./types"

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
  | { ok: false; error: "NO_PROVIDER" | "MISSING_KEY"; provider?: string }

export async function buildEngineDeps(
  ctx: PluginContext,
  options: BuildDepsOptions = {}
): Promise<BuildDepsResult> {
  const ai = getAiBridge(ctx)
  if (!ai) return { ok: false, error: "NO_PROVIDER" }

  const provider = readSearchProvider(ctx)
  const apiKey = await readApiKey(ctx, provider)
  if (!apiKey) return { ok: false, error: "MISSING_KEY", provider }

  const deps: EngineDeps = {
    ai,
    search: makeSearchFn({ provider, apiKey }),
    read: makeReadFn({ provider, apiKey }),
    logger: {
      info: (msg, ...args) => ctx.logger?.info?.(msg, ...args),
      warn: (msg, ...args) => ctx.logger?.warn?.(msg, ...args),
    },
    reportProgress: options.reportProgress,
    signal: options.signal,
  }
  return { ok: true, deps }
}
