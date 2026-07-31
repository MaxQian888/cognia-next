/**
 * Playwright globalSetup — boots the suite-wide mock services once per run
 * and publishes their base URLs into `process.env` so specs can build the
 * right credentials without each one having to spin up its own server.
 *
 * Mocks booted here:
 *   - MockV2Server         (mobile companion API — pair / status / events / sidecar RPC)
 *   - MockAnthropicServer  (AI nodes: /v1/messages, /v1/embeddings)
 *   - MockLarkServer       (action.connector.send/draft with Lark adapter)
 *   - MockVectorDbServer   (twin RAG, plugin vector ops)
 *
 * Additionally, when PLAYWRIGHT_TAURI_DRIVER=1 is set, this setup boots the
 * Tauri debug binary + tauri-driver and publishes the discovered CDP
 * websocket endpoint into `process.env.PLAYWRIGHT_TAURI_CDP_WS` so the
 * `tauri-driver` Playwright project can connect over CDP.
 *
 * Specs that need fine-grained scenario control still spin up their own
 * instance on a different port — the shared instances service everything
 * that just needs a reachable URL.
 *
 * Skip the mock fleet by setting PLAYWRIGHT_NO_GLOBAL_SETUP=1. Individual
 * mocks can be skipped with E2E_DISABLE_<MOCK>=1.
 */

import type { FullConfig } from "@playwright/test"
import { createMockV2Server, type MockV2Server } from "./mobile/mock-v2-server"
import { createMockAnthropicServer, type MockAnthropicServer } from "./mocks/anthropic/server"
import { createMockLarkServer, type MockLarkServer } from "./mocks/lark/server"
import { createMockVectorDbServer, type MockVectorDbServer } from "./mocks/vector-db/server"
import { launchTauriCdp, type TauriCdpHandle } from "./helpers/tauri-cdp-launch"

interface Booted {
  v2?: MockV2Server
  anthropic?: MockAnthropicServer
  lark?: MockLarkServer
  vectorDb?: MockVectorDbServer
  tauri?: TauriCdpHandle
}

const state: Booted = {}

async function startOrFallback<
  T extends { start(port: number): Promise<void>; port: number; baseUrl: string },
>(server: T, desiredPort: number): Promise<T> {
  await server.start(desiredPort).catch(async (err) => {
    if ((err as { code?: string } | undefined)?.code === "EADDRINUSE") {
      await server.start(0)
      return
    }
    throw err
  })
  return server
}

async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  if (!process.env.E2E_DISABLE_V2) {
    state.v2 = await startOrFallback(
      createMockV2Server(),
      Number(process.env.E2E_V2_PORT ?? "7891")
    )
    process.env.E2E_V2_BASE_URL = state.v2.baseUrl
    process.env.E2E_V2_PORT_RESOLVED = String(state.v2.port)
  }
  if (!process.env.E2E_DISABLE_ANTHROPIC) {
    state.anthropic = await startOrFallback(
      createMockAnthropicServer(),
      Number(process.env.E2E_ANTHROPIC_PORT ?? "7892")
    )
    process.env.E2E_ANTHROPIC_BASE_URL = state.anthropic.baseUrl
    process.env.E2E_ANTHROPIC_PORT_RESOLVED = String(state.anthropic.port)
  }
  if (!process.env.E2E_DISABLE_LARK) {
    state.lark = await startOrFallback(
      createMockLarkServer(),
      Number(process.env.E2E_LARK_PORT ?? "7894")
    )
    process.env.E2E_LARK_BASE_URL = state.lark.baseUrl
    process.env.E2E_LARK_PORT_RESOLVED = String(state.lark.port)
  }
  if (!process.env.E2E_DISABLE_VECTOR_DB) {
    state.vectorDb = await startOrFallback(
      createMockVectorDbServer(),
      Number(process.env.E2E_VECTOR_DB_PORT ?? "7895")
    )
    process.env.E2E_VECTOR_DB_BASE_URL = state.vectorDb.baseUrl
    process.env.E2E_VECTOR_DB_PORT_RESOLVED = String(state.vectorDb.port)
  }

  // Boot the Tauri debug binary + CDP bridge only when the `tauri` project
  // is opted into via env. PLAYWRIGHT_TAURI is the canonical switch;
  // PLAYWRIGHT_TAURI_DRIVER is honored as a legacy alias for one release cycle.
  //
  // Never let this launch abort the run: a throw out of globalSetup kills
  // EVERY project, not just `tauri` — chromium/mobile must keep running when
  // the Tauri shell can't boot. On failure the tauri fixtures fail on their
  // own with a clear "PLAYWRIGHT_TAURI_CDP_WS not set" error. The WebView2
  // CDP trick is Windows-only by decision (see tauri-cdp-launch.ts header),
  // so warn-and-skip on other platforms instead of burning the 60s CDP wait.
  if (process.env.PLAYWRIGHT_TAURI === "1" || process.env.PLAYWRIGHT_TAURI_DRIVER === "1") {
    if (process.platform !== "win32") {
      console.error(
        "[global-setup] PLAYWRIGHT_TAURI=1 on a non-Windows platform: the tauri " +
          "project drives WebView2 over CDP, which only exists on Windows " +
          "(macOS WKWebView / Linux webkit2gtk expose no CDP endpoint). " +
          "Skipping the Tauri launch — tauri specs will fail individually; " +
          "chromium/mobile projects are unaffected."
      )
    } else {
      try {
        state.tauri = await launchTauriCdp()
        process.env.PLAYWRIGHT_TAURI_CDP_WS = state.tauri.cdpWsEndpoint
      } catch (err) {
        console.error(
          `[global-setup] Tauri CDP launch failed — the tauri project will fail on its own, ` +
            `other projects continue: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  return async () => {
    await Promise.all(
      (
        Object.values(state) as Array<
          { stop?: () => Promise<void>; teardown?: () => Promise<void> } | undefined
        >
      ).map(async (s) => {
        try {
          if (s && "stop" in s && typeof s.stop === "function") await s.stop()
          if (s && "teardown" in s && typeof s.teardown === "function") await s.teardown()
        } catch {
          // teardown best-effort
        }
      })
    )
    state.v2 = undefined
    state.anthropic = undefined
    state.lark = undefined
    state.vectorDb = undefined
    state.tauri = undefined
  }
}

export default globalSetup
