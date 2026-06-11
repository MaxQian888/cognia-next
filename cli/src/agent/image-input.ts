/**
 * Multimodal prompt assembly for the CLI. The terminal composer is text-only,
 * so an image is attached the same way a file is referenced elsewhere in the
 * TUI: an `@<path>` token. When the prompt references one or more image files
 * (`@shot.png`, `@./diagrams/a.jpg`, …), they are read, base64-encoded, and
 * appended as Anthropic image content blocks.
 *
 * The transport is already multimodal end-to-end (`SendContent = string |
 * SendContentBlock[]` → sidecar → Anthropic / AI SDK), so this is the only
 * CLI-side piece: turn the typed string into `SendContent`.
 *
 * Pure: fs access is injected so it unit-tests without disk. Best-effort — a
 * missing/unreadable image degrades to an inline note in the text rather than
 * failing the turn, and a prompt with no image refs returns the plain string
 * unchanged (so non-image turns keep the exact original wire shape).
 */
import nodeFs from "node:fs"
import path from "node:path"

import type { SendContent, SendContentBlock } from "@/lib/claude/types"

/** Extension → Anthropic `media_type`. Only formats the vision models accept. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export interface ImageInputDeps {
  /** Read a file as bytes. Defaults to `fs.readFileSync`. */
  readFile?: (absPath: string) => Buffer
  /** Whether a path exists and is a file. Defaults to `fs.statSync`. */
  isFile?: (absPath: string) => boolean
}

export interface BuiltSendContent {
  /** Plain string when no images were attached, else a content-block array. */
  content: SendContent
  /** Count of images successfully encoded. */
  imageCount: number
  /** Referenced image paths that could not be read. */
  failed: string[]
}

/**
 * `@`-tokens that end in an image extension. The path runs to the next
 * whitespace; a trailing sentence punctuation mark (.,;:!?) is not part of the
 * filename and is trimmed. Matches POSIX and Windows separators.
 */
const IMAGE_REF = /@([^\s]+\.(?:png|jpe?g|gif|webp))/gi

export function extractImageRefs(prompt: string): string[] {
  const refs: string[] = []
  for (const m of prompt.matchAll(IMAGE_REF)) {
    let p = m[1]
    // A token like `@a.png.` (end of sentence) keeps the real extension.
    p = p.replace(/[.,;:!?]+$/, (tail) => (IMAGE_MEDIA_TYPES[path.extname(p)] ? "" : tail))
    refs.push(p)
  }
  return refs
}

function mediaTypeOf(p: string): string | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(p).toLowerCase()]
}

/**
 * Turn a typed prompt into {@link SendContent}, encoding any `@image` refs as
 * base64 image blocks. The full prompt text (including the `@path` tokens, so
 * the model has the filename context) is kept as the leading text block.
 */
export function buildSendContent(
  prompt: string,
  cwd: string,
  deps: ImageInputDeps = {}
): BuiltSendContent {
  const readFile = deps.readFile ?? ((p: string) => nodeFs.readFileSync(p))
  const isFile =
    deps.isFile ??
    ((p: string) => {
      try {
        return nodeFs.statSync(p).isFile()
      } catch {
        return false
      }
    })

  const refs = extractImageRefs(prompt)
  if (refs.length === 0) return { content: prompt, imageCount: 0, failed: [] }

  const blocks: SendContentBlock[] = []
  const failed: string[] = []
  for (const ref of refs) {
    const abs = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref)
    const mediaType = mediaTypeOf(ref)
    if (!mediaType || !isFile(abs)) {
      failed.push(ref)
      continue
    }
    try {
      const data = readFile(abs).toString("base64")
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } })
    } catch {
      failed.push(ref)
    }
  }

  if (blocks.length === 0) return { content: prompt, imageCount: 0, failed }

  const note = failed.length > 0 ? `\n\n[could not read image: ${failed.join(", ")}]` : ""
  return {
    content: [{ type: "text", text: prompt + note }, ...blocks],
    imageCount: blocks.length,
    failed,
  }
}
