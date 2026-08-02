/**
 * `AgentInput` → the prompt string the runtime already knows how to handle.
 *
 * Both backends (`session-context.ts` for the built-in sidecar,
 * `external-agent-session.ts` for external agents) already run every prompt
 * through `buildAttachmentContent`, which extracts `@<path>` references and
 * routes each one by kind: images become native content blocks, native-PDF
 * becomes a document block, rich documents are text-extracted, and anything
 * that needs it goes through OCR.
 *
 * So the SDK's job here is NOT to build attachment content — that would be a
 * second, divergent copy of a pipeline that already handles a dozen file kinds
 * and two model modalities. Its job is to LOWER a structured `AgentInput` into
 * the `@path` form the existing builder consumes, and to give in-memory
 * (base64) attachments a path to be referenced by.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

import { classifyRef } from "@/cli/src/agent/attachments/classify"

/** A file already on disk, referenced by path. */
export interface AgentPathAttachment {
  kind: "path"
  /** Absolute, or relative to the session's `cwd`. */
  path: string
}

/** Bytes the caller holds in memory — spilled to a temp file to be referenced. */
export interface AgentBase64Attachment {
  kind: "base64"
  data: string
  /** e.g. `"image/png"`, `"application/pdf"`. Drives the file extension. */
  mediaType: string
  /** Preferred file name; sanitized. Falls back to `attachment-<n>.<ext>`. */
  filename?: string
}

export type AgentAttachment = AgentPathAttachment | AgentBase64Attachment

/**
 * What you send the agent. A bare string is the common case and stays exactly
 * equivalent to `{ text }` — including its `@path` references, which keep
 * working untouched.
 */
export type AgentInput = string | { text?: string; attachments?: readonly AgentAttachment[] }

export interface LoweredInput {
  /** Prompt string carrying every attachment as an `@path` reference. */
  prompt: string
  /** Temp files written for base64 attachments. Always call it. */
  cleanup: () => void
}

/** Minimal extension map. Unknown media types get no extension, which the
 * classifier then treats by content rather than by a wrong guess. */
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
}

/**
 * Strip everything but a safe basename.
 *
 * A caller-supplied filename reaches `path.join` with a directory we control,
 * so `../../.ssh/authorized_keys` must not be able to climb out of the temp
 * directory — the attachment would be WRITTEN there, not just read.
 */
export function safeAttachmentName(filename: string | undefined, index: number): string {
  const base = filename ? path.basename(filename) : ""
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned.slice(0, 128) : `attachment-${index}`
}

/**
 * Always emit the QUOTED `@"path"` form.
 *
 * The bare form splits on whitespace, so "Screen Shot 2026-01-01.png" — the
 * single most common attachment on macOS — would be silently truncated to a
 * path that does not exist. A structured attachment is data, not prose, so
 * there is no reason to make it guess: quote unconditionally.
 */
function attachmentRef(target: string): string {
  return `@"${target}"`
}

/**
 * Reject a file the attachment pipeline has no handler for, up front.
 *
 * `buildAttachmentContent` records an unclassifiable ref in its `skipped` list
 * and carries on. That is right for a human typing `@notes` mid-sentence — but
 * for a caller who deliberately attached a file, being skipped is
 * indistinguishable from being read. Fail here, where we can name the file.
 */
function unsupportedAttachment(target: string, index: number): AgentStructuredError | null {
  if (classifyRef(target) !== "unknown") return null
  return {
    code: "config_error",
    message:
      `attachment ${index} (${path.basename(target)}) has no recognized file type — ` +
      `the agent cannot read it. Attach a text, image, PDF or document file, ` +
      `or inline its contents in the prompt.`,
    detail: { index, attachment: path.basename(target) },
  }
}

export interface LowerInputOptions {
  /** Directory for spilled base64 bytes. Defaults to a fresh temp dir. */
  tempDir?: string
  mkdtemp?: (prefix: string) => string
  writeFile?: (target: string, data: Buffer) => void
  rm?: (target: string) => void
}

/**
 * Lower an {@link AgentInput} to a prompt string.
 *
 * Returns a structured error rather than throwing, so an SDK caller passing a
 * malformed attachment gets the same `config_error` shape the CLI and RPC
 * surfaces report.
 */
export function lowerAgentInput(
  input: AgentInput,
  options: LowerInputOptions = {}
): { ok: true; value: LoweredInput } | { ok: false; error: AgentStructuredError } {
  if (typeof input === "string") {
    return { ok: true, value: { prompt: input, cleanup: () => {} } }
  }

  const text = input.text ?? ""
  const attachments = input.attachments ?? []
  if (attachments.length === 0) {
    return { ok: true, value: { prompt: text, cleanup: () => {} } }
  }

  const mkdtemp = options.mkdtemp ?? ((prefix: string) => fs.mkdtempSync(prefix))
  const writeFile = options.writeFile ?? ((target, data) => fs.writeFileSync(target, data))
  const rm = options.rm ?? ((target) => fs.rmSync(target, { recursive: true, force: true }))

  const refs: string[] = []
  const written: string[] = []
  let spillDir: string | null = null

  // Cleanup must remove what was actually written even if lowering fails
  // partway — a rejected input must not leave the caller's bytes on disk.
  const cleanup = () => {
    for (const file of written.splice(0)) {
      try {
        rm(file)
      } catch {
        // Best effort: a temp file we cannot remove is not worth failing a run.
      }
    }
    if (spillDir) {
      try {
        rm(spillDir)
      } catch {
        // Same.
      }
      spillDir = null
    }
  }

  for (const [index, attachment] of attachments.entries()) {
    if (attachment.kind === "path") {
      const target = attachment.path?.trim()
      if (!target) {
        cleanup()
        return {
          ok: false,
          error: {
            code: "config_error",
            message: `attachment ${index} has an empty path`,
            detail: { index },
          },
        }
      }
      const unsupported = unsupportedAttachment(target, index)
      if (unsupported) {
        cleanup()
        return { ok: false, error: unsupported }
      }
      refs.push(attachmentRef(target))
      continue
    }

    if (typeof attachment.data !== "string" || attachment.data.length === 0) {
      cleanup()
      return {
        ok: false,
        error: {
          code: "config_error",
          message: `attachment ${index} has no base64 data`,
          detail: { index },
        },
      }
    }

    // Node's base64 decoder is famously permissive — it silently drops invalid
    // characters rather than failing. Re-encoding and comparing lengths is the
    // cheap way to notice that the caller handed us something that is not
    // base64 at all, instead of writing a truncated file the model then
    // "reads" as a corrupt image.
    const bytes = Buffer.from(attachment.data, "base64")
    if (bytes.length === 0 || bytes.toString("base64").length < attachment.data.length / 2) {
      cleanup()
      return {
        ok: false,
        error: {
          code: "config_error",
          message: `attachment ${index} is not valid base64`,
          detail: { index },
        },
      }
    }

    const extension = MEDIA_TYPE_EXTENSIONS[attachment.mediaType] ?? ""
    let name = safeAttachmentName(attachment.filename, index)
    if (extension && !name.toLowerCase().endsWith(extension)) name += extension
    // Classify BEFORE spilling: an unreadable media type should cost the caller
    // an error message, not a temp file written and then deleted.
    const unsupported = unsupportedAttachment(name, index)
    if (unsupported) {
      cleanup()
      return {
        ok: false,
        error: {
          ...unsupported,
          message: `attachment ${index} has unsupported mediaType "${attachment.mediaType}" — the agent cannot read it`,
          detail: { index, mediaType: attachment.mediaType },
        },
      }
    }

    if (!spillDir) {
      spillDir = options.tempDir ?? mkdtemp(path.join(os.tmpdir(), "cognia-agent-input-"))
    }
    const target = path.join(spillDir, name)
    try {
      writeFile(target, bytes)
    } catch (err) {
      cleanup()
      return {
        ok: false,
        error: {
          code: "config_error",
          message: `could not write attachment ${index}: ${err instanceof Error ? err.message : String(err)}`,
          detail: { index },
        },
      }
    }
    written.push(target)
    refs.push(attachmentRef(target))
  }

  // Attachments trail the text so the model reads the instruction first; a
  // caller who wants a different order can put their own `@path` in `text`.
  const prompt = [text.trim(), refs.join(" ")].filter(Boolean).join("\n\n")
  return { ok: true, value: { prompt, cleanup } }
}
