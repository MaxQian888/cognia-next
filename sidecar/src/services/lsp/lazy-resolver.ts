// Shared lazy LSP resolver construction for both dispatch paths.
//
// Lifted from anthropic.mjs so the ai-sdk path gets the identical lazy-proxy
// semantics: the resolver (and any language server) is created only on first
// use, and the proxy degrades cleanly when the LSP host is unavailable
// (mobile / dist not built). Callers MUST invoke `dispose()` at session end
// to tear down any servers the resolver started.

import { createSessionLspResolver } from "./service-loader.ts"
import type { SessionLspOptions } from "./service-loader.ts"
import type { LspResolver } from "./resolver.ts"
import type { LspSendOptions } from "./servers.ts"

/** The resolver surface the tools and hooks call; creates the real one on first use. */
export interface LazyLspResolver {
  request(file: string, method: string, payload?: Record<string, unknown>): Promise<unknown>
  getDiagnostics(file: string, opts?: { text?: string; waitMs?: number }): Promise<unknown[]>
}

export function makeLazyLspResolver(
  {
    sendOptions,
    log,
  }: {
    sendOptions: {
      lsp?: LspSendOptions | null
      cwd?: string
      builtinProcessSandbox?: SessionLspOptions["builtinProcessSandbox"]
    }
    log: (level: "info" | "warn" | "error", message: string) => void
  },
  createResolver: (
    opts: SessionLspOptions
  ) => Promise<LspResolver | null> = createSessionLspResolver
): { lspEnabled: boolean; lspResolver: LazyLspResolver | null; dispose(): void } {
  const lspConfig = sendOptions.lsp
  const lspEnabled = !!(lspConfig && lspConfig.enabled && sendOptions.cwd)
  let lspResolverPromise: Promise<LspResolver | null> | null = null

  const getLspResolver = () => {
    if (!lspResolverPromise) {
      lspResolverPromise = createResolver({
        cwd: sendOptions.cwd!,
        builtinProcessSandbox: sendOptions.builtinProcessSandbox,
        servers: lspConfig?.servers ?? [],
        installDir: lspConfig?.installDir,
        allowInstall: lspConfig?.autoInstall !== false,
        logger: { warn: (m) => log("warn", String(m)) },
      }).catch((e) => {
        // Surface the reason and clear the cached promise so a TRANSIENT
        // failure (installer race, first-run download hiccup) doesn't disable
        // LSP for the whole session — the next tool call retries.
        log(
          "warn",
          `LSP resolver init failed (will retry on next use): ${(e as Error | null)?.message ?? e}`
        )
        lspResolverPromise = null
        return null
      })
    }
    return lspResolverPromise
  }

  const lspResolver = lspEnabled
    ? {
        async request(file: string, method: string, payload?: Record<string, unknown>) {
          const r = await getLspResolver()
          if (!r)
            throw new Error(
              "LSP host unavailable. Rebuild the vscode-ext-host bundle or reinstall cognia-agent, then retry."
            )
          return r.request(file, method, payload)
        },
        async getDiagnostics(file: string, opts?: { text?: string; waitMs?: number }) {
          const r = await getLspResolver()
          if (!r)
            throw new Error(
              "LSP host unavailable. Rebuild the vscode-ext-host bundle or reinstall cognia-agent, then retry."
            )
          return r.getDiagnostics(file, opts)
        },
      }
    : null

  return {
    lspEnabled,
    lspResolver,
    dispose() {
      if (lspResolverPromise) {
        lspResolverPromise.then((r) => r?.dispose?.()).catch(() => {})
      }
    },
  }
}
