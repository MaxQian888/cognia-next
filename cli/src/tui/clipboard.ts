/**
 * Cross-platform clipboard write for the `/copy` command. Shells out to the
 * native clipboard utility (`clip` on Windows, `pbcopy` on macOS, `xclip`/
 * `wl-copy` on Linux). The spawner is injected so the App router unit-tests the
 * platform selection + piping without touching a real clipboard.
 */
import { spawn as nodeSpawn } from "node:child_process"

/** Minimal surface of `child_process.spawn` the writer needs. */
export type Spawn = typeof nodeSpawn

/** Pick the clipboard command + args for a platform, or null if unsupported. */
export function clipboardCommand(
  platform: NodeJS.Platform
): { cmd: string; args: string[] } | null {
  if (platform === "win32") return { cmd: "clip", args: [] }
  if (platform === "darwin") return { cmd: "pbcopy", args: [] }
  if (platform === "linux") return { cmd: "xclip", args: ["-selection", "clipboard"] }
  return null
}

/**
 * Write `text` to the OS clipboard. Resolves true on success, false when the
 * platform is unsupported or the helper process fails (e.g. xclip not
 * installed) — the caller turns a false into a user-facing notice.
 */
export function copyToClipboard(
  text: string,
  opts: { platform?: NodeJS.Platform; spawn?: Spawn } = {}
): Promise<boolean> {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? nodeSpawn
  const command = clipboardCommand(platform)
  if (!command) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.cmd, command.args, { stdio: ["pipe", "ignore", "ignore"] })
      child.on("error", () => resolve(false))
      child.on("close", (code) => resolve(code === 0))
      child.stdin?.end(text)
    } catch {
      resolve(false)
    }
  })
}
