/**
 * Read a text/code file referenced by `@<path>` and wrap its content in a
 * `<file path="…">` block to fold into the prompt string. Best-effort: a
 * missing/unreadable file returns `{ ok: false }` so the caller can note it.
 * Pure: fs access is injected for unit testing.
 */
import nodeFs from "node:fs"
import path from "node:path"

export const MAX_TEXT_INJECT_BYTES = 256 * 1024

export interface TextFileDeps {
  readFileUtf8?: (absPath: string) => string
  isFile?: (absPath: string) => boolean
}

export type TextFileResult = { ok: true; text: string } | { ok: false }

export function readTextFileBlock(
  ref: string,
  cwd: string,
  deps: TextFileDeps = {}
): TextFileResult {
  const readFileUtf8 = deps.readFileUtf8 ?? ((p: string) => nodeFs.readFileSync(p, "utf8"))
  const isFile =
    deps.isFile ??
    ((p: string) => {
      try {
        return nodeFs.statSync(p).isFile()
      } catch {
        return false
      }
    })

  const abs = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref)
  if (!isFile(abs)) return { ok: false }
  let content: string
  try {
    content = readFileUtf8(abs)
  } catch {
    return { ok: false }
  }
  const byteLen = Buffer.byteLength(content, "utf8")
  if (byteLen > MAX_TEXT_INJECT_BYTES) {
    const kept = Buffer.from(content, "utf8").subarray(0, MAX_TEXT_INJECT_BYTES).toString("utf8")
    content = `${kept}\n…[truncated ${byteLen - MAX_TEXT_INJECT_BYTES} bytes]`
  }
  return { ok: true, text: `<file path="${ref}">\n${content}\n</file>` }
}
