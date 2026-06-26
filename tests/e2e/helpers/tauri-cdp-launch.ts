/**
 * Boots the Tauri debug binary with WebView2 CDP enabled and returns the
 * Chrome DevTools Protocol websocket endpoint that Playwright can
 * `chromium.connectOverCDP(...)` against. Designed to be called once from
 * `tests/e2e/global-setup.ts` (worker-scope) and torn down at the end of the
 * Playwright run.
 *
 * Architecture note — we DON'T spawn `tauri-driver`. Playwright connects
 * directly to WebView2's DevTools over CDP; `tauri-driver` is a WebDriver
 * router for Selenium/WebdriverIO clients and plays no role here. Removing
 * its spawn dropped a hard dependency on `tauri-driver` being on PATH.
 *
 * Environment:
 *   PLAYWRIGHT_TAURI=1                   # opt-in switch (set by test:e2e:tauri).
 *                                        # PLAYWRIGHT_TAURI_DRIVER=1 is honored as
 *                                        # a legacy alias for one release cycle.
 *   PLAYWRIGHT_TAURI_BIN=<absolute path> # Path to the built Tauri exe (debug build).
 *                                        # If unset, defaults to
 *                                        # `target/debug/cognia(.exe)` under the
 *                                        # current working directory (workspace
 *                                        # root, since the Rust workspace lives
 *                                        # at the repo root).
 *   WEBVIEW2_REMOTE_DEBUGGING_PORT=9222  # CDP port for WebView2; defaults to 9222.
 *
 * The CDP env (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) is injected into the
 * spawned child process only. Production binaries built without this env
 * never expose CDP — this is the security invariant that lets us avoid
 * setting it inside `src-tauri/src/lib.rs`.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export interface TauriCdpHandle {
  cdpWsEndpoint: string
  teardown(): Promise<void>
}

const DEFAULT_CDP_PORT = 9222

function defaultBinaryPath(): string {
  const exe = process.platform === "win32" ? "cognia.exe" : "cognia"
  return path.resolve(process.cwd(), "target", "debug", exe)
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function waitForCdp(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const json = (await fetchJson(`http://127.0.0.1:${port}/json/version`, 500)) as {
      webSocketDebuggerUrl?: string
    } | null
    if (json?.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
    await delay(200)
  }
  throw new Error(`Timed out waiting for CDP on port ${port}`)
}

function isEnabled(): boolean {
  return process.env.PLAYWRIGHT_TAURI === "1" || process.env.PLAYWRIGHT_TAURI_DRIVER === "1"
}

export async function launchTauriCdp(): Promise<TauriCdpHandle> {
  if (!isEnabled()) {
    throw new Error(
      "launchTauriCdp requires PLAYWRIGHT_TAURI=1 (or legacy PLAYWRIGHT_TAURI_DRIVER=1)"
    )
  }
  const tauriBin = process.env.PLAYWRIGHT_TAURI_BIN ?? defaultBinaryPath()
  try {
    await access(tauriBin, fsConstants.F_OK)
  } catch {
    throw new Error(
      `Tauri debug binary not found at ${tauriBin}. ` +
        `Run \`pnpm tauri build --debug\` first or set PLAYWRIGHT_TAURI_BIN to the binary path.`
    )
  }

  const cdpPort = Number(process.env.WEBVIEW2_REMOTE_DEBUGGING_PORT ?? DEFAULT_CDP_PORT)

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
  }

  // Chat-core E2E enabler: point the REAL Claude sidecar at the in-process mock
  // Anthropic server (published by global-setup as `E2E_ANTHROPIC_BASE_URL`,
  // booted before this launcher runs) so specs can drive the full
  // compose → sidecar → stream → render path without calling api.anthropic.com.
  //
  // How it reaches the sidecar: the Tauri binary inherits this env, and the
  // sidecar spawn (`src-tauri/src/claude/sidecar.rs`) only OVERRIDES
  // ANTHROPIC_BASE_URL when a base URL is configured in the vault — which is
  // empty in the E2E flow — so the inherited value passes through to the
  // `@anthropic-ai/claude-agent-sdk` untouched. Test-helper only; production
  // binaries are built without these vars and never see them.
  const mockAnthropic = process.env.E2E_ANTHROPIC_BASE_URL
  if (mockAnthropic && !process.env.PLAYWRIGHT_TAURI_REAL_ANTHROPIC) {
    childEnv.ANTHROPIC_BASE_URL = mockAnthropic
    childEnv.ANTHROPIC_API_KEY = process.env.E2E_ANTHROPIC_API_KEY ?? "test-e2e-key"
    // Drop any inherited OAuth bearer: the SDK prefers it over the API key,
    // which would bypass the mock base URL. Auth-mode mixing is undefined.
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
  }

  const children: ChildProcess[] = []
  const child = spawn(tauriBin, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
    shell: false,
  })
  children.push(child)
  child.stderr?.on("data", (d) => {
    process.stderr.write(`[tauri] ${d}`)
  })

  const ws = await waitForCdp(cdpPort, 60_000)

  return {
    cdpWsEndpoint: ws,
    teardown: async () => {
      for (const c of children) {
        try {
          if (process.platform === "win32" && c.pid !== undefined) {
            // taskkill ensures detached WebView2 child processes also exit.
            spawn("taskkill", ["/pid", String(c.pid), "/f", "/t"], { shell: true })
          } else {
            c.kill("SIGTERM")
          }
        } catch {
          // best-effort
        }
      }
      await delay(250)
    },
  }
}
