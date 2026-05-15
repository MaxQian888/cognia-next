/**
 * Helper that boots `tauri-driver` + the Tauri debug binary, returning a
 * Chromium DevTools Protocol websocket endpoint that Playwright can
 * `chromium.connectOverCDP(...)` against. Designed to be called from
 * `tests/e2e/tauri/global-setup.ts`; not used by the Chromium / mobile
 * projects.
 *
 * Required environment:
 *   PLAYWRIGHT_TAURI_DRIVER=1            # opt-in switch (also set in playwright.config.ts gate)
 *   PLAYWRIGHT_TAURI_BIN=<absolute path> # Path to the built Tauri exe (debug build).
 *   TAURI_DRIVER_BIN=<absolute path>     # Path to `tauri-driver` (defaults to lookup on PATH).
 *   WEBVIEW2_REMOTE_DEBUGGING_PORT=9222  # WebView2 CDP port; defaults to 9222 if unset.
 *
 * The boot sequence is:
 *   1. Spawn `tauri-driver` (WebDriver router, port 4444 by default).
 *   2. Spawn the Tauri binary with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`
 *      so WebView2 listens on the CDP port. Wait until /json/version is reachable.
 *   3. Fetch `/json/version` to learn the CDP websocket endpoint.
 *   4. Return the WS endpoint + a teardown function.
 *
 * Failures during boot don't tear down the suite — they throw and the
 * Playwright project surfaces the error in the run report.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

export interface TauriDriverHandle {
  cdpWsEndpoint: string
  teardown(): Promise<void>
}

const DEFAULT_CDP_PORT = 9222

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

export async function launchTauriDriver(): Promise<TauriDriverHandle> {
  if (process.env.PLAYWRIGHT_TAURI_DRIVER !== "1") {
    throw new Error("launchTauriDriver requires PLAYWRIGHT_TAURI_DRIVER=1")
  }
  const tauriBin = process.env.PLAYWRIGHT_TAURI_BIN
  if (!tauriBin) {
    throw new Error("launchTauriDriver requires PLAYWRIGHT_TAURI_BIN=<path to tauri exe>")
  }
  const driverBin = process.env.TAURI_DRIVER_BIN ?? "tauri-driver"
  const cdpPort = Number(process.env.WEBVIEW2_REMOTE_DEBUGGING_PORT ?? DEFAULT_CDP_PORT)

  const children: ChildProcess[] = []
  const spawnOne = (bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
    })
    children.push(child)
    child.stderr?.on("data", (d) => {
      process.stderr.write(`[${bin}] ${d}`)
    })
    return child
  }

  // 1. tauri-driver — the WebDriver router. Best-effort: even when Playwright
  //    talks CDP directly to WebView2 we still launch it because Tauri-built
  //    binaries rely on the driver bridge for Tauri-specific IPC stubs.
  spawnOne(driverBin, [], {})

  // 2. The Tauri debug binary itself, told to expose WebView2's DevTools.
  spawnOne(tauriBin, [], {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-allow-origins=*`,
  })

  const ws = await waitForCdp(cdpPort, 60_000)

  return {
    cdpWsEndpoint: ws,
    teardown: async () => {
      for (const child of children) {
        try {
          if (process.platform === "win32") {
            // taskkill ensures detached WebView2 processes also exit.
            spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { shell: true })
          } else {
            child.kill("SIGTERM")
          }
        } catch {
          // best-effort
        }
      }
      // Give the OS a moment to release the port.
      await delay(250)
    },
  }
}
