/**
 * Cross-platform clipboard *image* read for the upcoming Ctrl+V paste flow.
 * Shells out to the native clipboard helper, captures the image as a PNG, and
 * reports the temp path back to the caller. Mirrors the write-only sibling
 * `clipboard.ts`: the spawner (and the disk-existence check) are injected so the
 * App router can unit-test the platform selection + child lifecycle without
 * touching a real clipboard or disk.
 *
 * ## stdout-vs-file: the per-platform difference the controller must know
 *
 * There are two distinct capture mechanisms depending on the helper:
 *
 * - **win32 / darwin — the helper writes the file itself.** PowerShell's
 *   `Clipboard.GetImage().Save(...)` and `osascript`'s write-to-POSIX-file both
 *   produce `outPath` directly. We only need to wait for the child to exit and
 *   then confirm the file is non-empty. `child.stdout` is ignored.
 *
 * - **linux — the helper streams the PNG to stdout.** `xclip -t image/png -o`
 *   prints raw PNG bytes to stdout and does NOT create a file. Here we pipe the
 *   child's stdout into a write stream at `outPath` ourselves, then confirm the
 *   resulting file is non-empty.
 *
 * `imageWritesToStdout(platform)` is the single source of truth for which mode a
 * platform uses, so a controller never has to special-case linux by hand.
 */
import { createWriteStream as fsCreateWriteStream } from "node:fs"
import { statSync } from "node:fs"
import { spawn as nodeSpawn } from "node:child_process"

/** Minimal surface of `child_process.spawn` the reader needs. */
export type Spawn = typeof nodeSpawn

/** A resolved clipboard-image command: the executable plus its argv. */
export interface ClipboardImageCmd {
  cmd: string
  args: string[]
}

/**
 * Whether the helper for `platform` emits the PNG on stdout (true) instead of
 * writing `outPath` itself (false). Only linux/xclip streams to stdout.
 */
export function imageWritesToStdout(platform: NodeJS.Platform): boolean {
  return platform === "linux"
}

/**
 * Pick the clipboard-image command + args for a platform, or null if
 * unsupported. The `outPath` is baked into the win32/darwin commands (they write
 * the file directly); on linux the command writes to stdout and `outPath` is
 * used by the caller for the redirect target instead.
 */
export function clipboardImageCommand(
  platform: NodeJS.Platform,
  outPath: string
): ClipboardImageCmd | null {
  if (platform === "win32") {
    // Single -Command string: grab the bitmap and Save() it as PNG. No output
    // is written when the clipboard holds no image, so `fileReady` stays false.
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "Add-Type -AssemblyName System.Drawing; " +
      "$img=[System.Windows.Forms.Clipboard]::GetImage(); " +
      `if($img){ $img.Save('${outPath}', ` +
      "[System.Drawing.Imaging.ImageFormat]::Png) }"
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
    }
  }
  if (platform === "darwin") {
    // Pull the PNG flavour off the clipboard and write the bytes to outPath.
    // `the clipboard as «class PNGf»` throws when no image is present, so the
    // try-block leaves outPath absent → `fileReady` stays false.
    const script =
      "try\n" +
      "set pngData to (the clipboard as «class PNGf»)\n" +
      `set f to (open for access POSIX file "${outPath}" with write permission)\n` +
      "set eof f to 0\n" +
      "write pngData to f\n" +
      "close access f\n" +
      "end try"
    return { cmd: "osascript", args: ["-e", script] }
  }
  if (platform === "linux") {
    // xclip prints the raw PNG to stdout; the caller redirects it to outPath.
    return {
      cmd: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    }
  }
  return null
}

/** A default temp PNG path under the OS temp dir. */
function defaultOutPath(): string {
  const dir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp"
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"
  return `${dir}${sep}cognia-clip-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`
}

/** Default existence + non-empty check via `fs.statSync` (size > 0). */
function defaultFileReady(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

/** Options for {@link readClipboardImage}; everything is injectable for tests. */
export interface ReadClipboardImageOpts {
  /** Override the detected platform (default: `process.platform`). */
  platform?: NodeJS.Platform
  /** Inject a fake `child_process.spawn` (default: node's spawn). */
  spawn?: Spawn
  /** Inject the temp output path (default: a random file in the temp dir). */
  outPath?: string
  /** Inject the existence + non-empty check (default: `fs.statSync` size > 0). */
  fileReady?: (p: string) => boolean
  /** Inject the stdout sink factory (default: `fs.createWriteStream`). */
  createWriteStream?: (p: string) => NodeJS.WritableStream
}

/**
 * Read an image off the OS clipboard into a temp PNG. Resolves `{ path }` on
 * success, or `null` when: the platform is unsupported, the helper process
 * fails (non-zero exit / spawn error), or the clipboard held no image (the
 * output file is missing or empty).
 *
 * See the module header for the stdout-vs-file capture difference; this function
 * handles both transparently via {@link imageWritesToStdout}.
 */
export function readClipboardImage(
  opts: ReadClipboardImageOpts = {}
): Promise<{ path: string } | null> {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? nodeSpawn
  const outPath = opts.outPath ?? defaultOutPath()
  const fileReady = opts.fileReady ?? defaultFileReady
  const createWriteStream =
    opts.createWriteStream ??
    ((p: string) => fsCreateWriteStream(p) as unknown as NodeJS.WritableStream)

  const command = clipboardImageCommand(platform, outPath)
  if (!command) return Promise.resolve(null)

  const toStdout = imageWritesToStdout(platform)

  return new Promise<{ path: string } | null>((resolve) => {
    try {
      const child = spawn(command.cmd, command.args, {
        stdio: ["ignore", toStdout ? "pipe" : "ignore", "ignore"],
      })

      // linux: stream the PNG bytes from stdout into outPath ourselves.
      let sink: NodeJS.WritableStream | null = null
      if (toStdout && child.stdout) {
        sink = createWriteStream(outPath)
        child.stdout.on("data", (chunk: Buffer) => sink?.write(chunk))
      }

      child.on("error", () => resolve(null))
      child.on("close", (code) => {
        sink?.end()
        if (code !== 0) return resolve(null)
        // Both modes converge here: confirm the file actually has bytes.
        resolve(fileReady(outPath) ? { path: outPath } : null)
      })
    } catch {
      resolve(null)
    }
  })
}
