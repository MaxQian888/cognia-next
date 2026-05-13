/**
 * Cloudflared one-click tunnel manager.
 *
 * Spawns `cloudflared tunnel --url http://127.0.0.1:<port>` and watches its
 * stderr / stdout for the assigned `*.trycloudflare.com` URL. The URL is
 * then handed back to the caller so the Settings UI can surface it as the
 * webhook endpoint to paste into GitHub.
 *
 * The actual `cloudflared` binary is expected on PATH (Tauri-only). The web
 * build calls into this module and immediately rejects with a clear "desktop
 * only" error.
 *
 * For testability the module accepts a `SpawnLike` factory which returns an
 * object with stdout/stderr async iterators. The default implementation uses
 * Tauri's `@tauri-apps/plugin-shell` Command API; tests inject a fake.
 */

/** Pattern Cloudflare uses for free tunnels. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/** Time we'll wait for the URL line to appear before aborting. */
const URL_WAIT_MS = 30_000

export interface CloudflaredHandle {
  /** The public HTTPS URL pointing at our local webhook receiver. */
  publicUrl: string
  /** Stop the tunnel. Idempotent. */
  stop(): Promise<void>
}

/**
 * Minimal subset of the process surface we depend on. Concrete impls:
 *   - Tauri:  wraps `@tauri-apps/plugin-shell` Command
 *   - Tests:  returns a fake driven by manual emit() calls
 */
export interface CloudflaredProcess {
  /** Resolves when the process exits. */
  waitForExit(): Promise<number>
  /** Yield each stdout line as it arrives. */
  stdoutLines(): AsyncIterable<string>
  /** Yield each stderr line as it arrives. */
  stderrLines(): AsyncIterable<string>
  /** Send SIGTERM / kill. Idempotent. */
  kill(): Promise<void>
}

export interface CloudflaredOptions {
  /** Local port the webhook receiver bound to (e.g. 17243). */
  localPort: number
  /** Optional explicit URL to test against (skips spawning entirely — used to wire CI fixtures). */
  fixedUrl?: string
  /** Override the spawn implementation. Required outside Tauri / outside tests. */
  spawn?: (args: string[]) => Promise<CloudflaredProcess>
  /** Cap wait time for URL discovery. */
  waitMs?: number
}

export function parseTrycloudflareUrl(line: string): string | null {
  const m = TUNNEL_URL_RE.exec(line)
  return m ? m[0] : null
}

/**
 * Watch process output for the URL line. Resolves on the first match;
 * rejects if the process exits first or the wait deadline elapses.
 */
async function awaitUrl(proc: CloudflaredProcess, waitMs: number): Promise<string> {
  let timer: NodeJS.Timeout | null = null
  const winners: Promise<string>[] = []

  const fromLines = (lines: AsyncIterable<string>): Promise<string> =>
    (async () => {
      for await (const line of lines) {
        const url = parseTrycloudflareUrl(line)
        if (url) return url
      }
      // Iterator ended without a match. Stay quiet — the exit / timeout
      // promises will decide whether this is a real failure or just one of
      // the two streams running dry while the other is still emitting.
      return new Promise<string>(() => {})
    })()

  winners.push(fromLines(proc.stdoutLines()))
  winners.push(fromLines(proc.stderrLines()))
  winners.push(
    new Promise<string>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`cloudflared: no URL after ${waitMs}ms`)), waitMs)
    })
  )
  winners.push(
    (async () => {
      const code = await proc.waitForExit()
      throw new Error(`cloudflared exited (code ${code}) before printing a URL`)
    })()
  )

  try {
    return await Promise.race(winners)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Start a Cloudflare quick-tunnel pointing at `localPort` and return a
 * handle once the public URL is known. Caller must call `handle.stop()`
 * when finished.
 */
export async function startTunnel(opts: CloudflaredOptions): Promise<CloudflaredHandle> {
  if (opts.fixedUrl) {
    return { publicUrl: opts.fixedUrl, stop: async () => {} }
  }
  if (!opts.spawn) {
    throw new Error(
      "cloudflared: this build doesn't have a spawn implementation wired " +
        "(web mode, or the plugin entry didn't pass one). Run cognia in desktop mode."
    )
  }
  const proc = await opts.spawn([
    "tunnel",
    "--url",
    `http://127.0.0.1:${opts.localPort}`,
    "--no-autoupdate",
    "--metrics",
    "127.0.0.1:0",
  ])
  const url = await awaitUrl(proc, opts.waitMs ?? URL_WAIT_MS)
  return {
    publicUrl: url,
    stop: () => proc.kill(),
  }
}
