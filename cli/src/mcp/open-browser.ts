/**
 * Cross-platform "open this URL in the default browser" helper for the MCP
 * OAuth flow (`/mcp auth`). Shells out to the native opener (`start` on Windows,
 * `open` on macOS, `xdg-open` on Linux). The spawner is injected so the OAuth
 * flow unit-tests the platform selection without launching a real browser.
 *
 * Mirrors the pattern in `tui/clipboard.ts`.
 */
import { spawn as nodeSpawn } from "node:child_process"

export type Spawn = typeof nodeSpawn

/** Pick the URL-open command + args for a platform, or null if unsupported. */
export function openCommand(
  platform: NodeJS.Platform,
  url: string
): { cmd: string; args: string[] } | null {
  if (platform === "win32") {
    // `start` is a cmd.exe builtin; the empty "" is the window title arg so a
    // URL with `&` isn't mis-parsed. Quoting is handled by spawn arg array.
    return { cmd: "cmd", args: ["/c", "start", "", url] }
  }
  if (platform === "darwin") return { cmd: "open", args: [url] }
  if (platform === "linux") return { cmd: "xdg-open", args: [url] }
  return null
}

/**
 * Open `url` in the user's default browser. Resolves true on a clean launch,
 * false when the platform is unsupported or the opener process errors — the
 * caller prints the URL as a fallback so the user can paste it manually.
 */
export function openBrowser(
  url: string,
  opts: { platform?: NodeJS.Platform; spawn?: Spawn } = {}
): Promise<boolean> {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? nodeSpawn
  const command = openCommand(platform, url)
  if (!command) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.cmd, command.args, { stdio: "ignore", detached: false })
      child.on("error", () => resolve(false))
      // The opener forks the browser and exits ~immediately; a 0 exit is success.
      child.on("spawn", () => resolve(true))
    } catch {
      resolve(false)
    }
  })
}
