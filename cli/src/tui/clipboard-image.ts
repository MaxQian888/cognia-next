/**
 * Cross-platform clipboard *image* read for the Ctrl+V paste flow.
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
 *   `Clipboard.GetImage().Save(...)` and AppKit's PNG encoder both
 *   produce `outPath` directly. We only need to wait for the child to exit and
 *   then confirm the file is non-empty. `child.stdout` is ignored.
 *
 * - **linux — the helper streams the PNG to stdout.** `xclip -t image/png -o` or `wl-paste --type image/png`
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
 * writing `outPath` itself (false). Only Linux helpers stream to stdout.
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
  outPath: string,
  env: NodeJS.ProcessEnv = process.env
): ClipboardImageCmd | null {
  if (platform === "win32") {
    // Single -Command string: grab the bitmap and Save() it as PNG. No output
    // is written when the clipboard holds no image, so `fileReady` stays false.
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "Add-Type -AssemblyName System.Drawing; " +
      "$img=[System.Windows.Forms.Clipboard]::GetImage(); " +
      `if($img){ $img.Save('${outPath.replace(/'/g, "''")}', ` +
      "[System.Drawing.Imaging.ImageFormat]::Png) }"
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
    }
  }
  if (platform === "darwin") {
    // AppKit accepts native TIFF/bitmap data as well as PNG. Pass paths as
    // argv so spaces, quotes and backslashes cannot alter the helper script.
    const script = `ObjC.import('AppKit');
function run(argv) {
  const board = argv[1] ? $.NSPasteboard.pasteboardWithName(argv[1]) : $.NSPasteboard.generalPasteboard;
  const file = board.stringForType('public.file-url');
  const url = file && !file.isNil() ? $.NSURL.URLWithString(file) : null;
  const image = url && url.isFileURL ? $.NSImage.alloc.initWithContentsOfURL(url) : $.NSImage.alloc.initWithPasteboard(board);
  if (!image || image.isNil()) return;
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSPNGFileType, {});
  if (!png || png.isNil() || !png.writeToFileAtomically(argv[0], true)) throw Error('Could not save clipboard image');
}`
    return { cmd: "osascript", args: ["-l", "JavaScript", "-e", script, outPath] }
  }
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY)
      return { cmd: "wl-paste", args: ["--no-newline", "--type", "image/png"] }
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
  env?: NodeJS.ProcessEnv
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

  const command = clipboardImageCommand(platform, outPath, opts.env)
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
        sink.on("error", () => resolve(null))
        child.stdout.on("data", (chunk: Buffer) => sink?.write(chunk))
      }

      child.on("error", () => resolve(null))
      child.on("close", (code) => {
        if (code !== 0) {
          sink?.end()
          resolve(null)
          return
        }
        // A stdout helper can exit before its PNG has finished flushing to disk.
        const complete = () => resolve(fileReady(outPath) ? { path: outPath } : null)
        if (sink) sink.end(complete)
        else complete()
      })
    } catch {
      resolve(null)
    }
  })
}

// ---------------------------------------------------------------------------
// Presence probe
//
// `readClipboardImage` above answers "give me the image"; the probe answers
// "is there an image" without writing a file, so a poll loop can run it every
// couple of seconds without leaking temp PNGs. Each platform's command prints
// "1"/"0" (macOS, Windows) or the clipboard's advertised MIME list (Linux).
// ---------------------------------------------------------------------------

/** Native image UTIs the macOS pasteboard advertises. */
const MAC_IMAGE_UTI =
  /^(public\.(png|tiff|jpeg|gif|webp|heic|heif|heics|bmp|pict|avif)|com\.(compuserve\.gif|apple\.pict)|NeXT TIFF)/i

/** Extension check for clipboard *file* drops (an image path, not pixels). */
const IMAGE_FILE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|heics|svg|avif)(\?|#|$)/i

/**
 * Command that reports whether the clipboard CURRENTLY holds an image —
 * either image pixels or a file drop pointing at an image. Prints "1"/"0" on
 * macOS/Windows; on Linux it prints the advertised type list for the caller
 * to scan ({@link probeOutputHasImage}). Returns null on unsupported
 * platforms. Exported for tests.
 */
export function clipboardImageProbeCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env
): ClipboardImageCmd | null {
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "$c=[System.Windows.Forms.Clipboard]; " +
      "if($c.ContainsImage()){ '1' } " +
      "elseif($c.ContainsFileDropList() -and " +
      "@($c.GetFileDropList() | Where-Object { $_ -match '\\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|heics|svg|avif)$' }).Count -gt 0){ '1' } " +
      "else { '0' }"
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
    }
  }
  if (platform === "darwin") {
    // Optional argv[0] = a named pasteboard (tests). Same surface as the
    // reader script, but it only inspects `types` — no decode, no file.
    const script = `ObjC.import('AppKit');
function run(argv) {
  const board = argv[0] ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard;
  const types = ObjC.deepUnwrap(board.types) || [];
  const imageUti = ${String(MAC_IMAGE_UTI)};
  const imageFile = ${String(IMAGE_FILE_EXT)};
  for (const t of types) {
    if (imageUti.test(String(t))) return '1';
  }
  const file = board.stringForType('public.file-url');
  if (file && !file.isNil() && imageFile.test(String(ObjC.unwrap(file)))) return '1';
  return '0';
}`
    return { cmd: "osascript", args: ["-l", "JavaScript", "-e", script] }
  }
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) return { cmd: "wl-paste", args: ["--list-types"] }
    return { cmd: "xclip", args: ["-selection", "clipboard", "-t", "TARGETS", "-o"] }
  }
  return null
}

/**
 * Interpret a probe command's stdout: `true` when the clipboard advertises
 * image content. Linux helpers list MIME types — any `image/*` line counts;
 * Windows/macOS probes print a literal "1".
 */
export function probeOutputHasImage(platform: NodeJS.Platform, stdout: string): boolean {
  if (platform === "linux") return /^image\//im.test(stdout)
  return stdout.trim() === "1"
}

/** Options for {@link hasClipboardImage}; everything is injectable for tests. */
export interface HasClipboardImageOpts {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: Spawn
}

/**
 * Check whether the system clipboard currently holds an image. Cheap and
 * side-effect free — reads only the advertised type list, so it is safe to
 * call on a poll loop. Returns false for unsupported platforms, missing
 * helper tools, and helper failures (never throws).
 */
export function hasClipboardImage(opts: HasClipboardImageOpts = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform
  const spawn = opts.spawn ?? nodeSpawn
  const command = clipboardImageProbeCommand(platform, opts.env)
  if (!command) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.cmd, command.args, { stdio: ["ignore", "pipe", "ignore"] })
      let out = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8")
      })
      child.on("error", () => resolve(false))
      child.on("close", (code) => {
        resolve(code === 0 && probeOutputHasImage(platform, out))
      })
    } catch {
      resolve(false)
    }
  })
}
