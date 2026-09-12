/**
 * Clipboard Tools — built-in plugin.
 *
 * Every clipboard byte goes through `ctx.clipboard`, the host's
 * permission-guarded and rate-limited clipboard API (`clipboard:read` /
 * `clipboard:write`). The plugin used to open the OS clipboard itself — the
 * Tauri clipboard plugin on the desktop, `navigator.clipboard` elsewhere —
 * which bypassed the permission guard and the rate limiter and was the only
 * reason it had to know which shell it ran in. The host answers "browser or
 * desktop" per call, so the plugin no longer carries a shell probe.
 *
 * Contributions (all declared in `plugin.json` so they are discoverable
 * before activation; the executors are attached here):
 *   - Agent tools: `clipboard_status`, `clipboard_read_image`,
 *     `clipboard_write_text`, `clipboard_clear`.
 *   - Workflow nodes: `action.readText`, `action.writeText`, `action.clear`.
 */
import {
  definePlugin,
  definePluginTool,
  defineWorkflowNode,
  type PluginContext,
  type PluginManifest,
  type PluginToolRegistration,
} from "@cognia/plugin-sdk"
import type { PluginNodeDef } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

type ClipboardAPI = PluginContext["clipboard"]

export interface ClipboardFailure {
  ok: false
  error: string
}

export interface ClipboardStatusResult {
  ok: true
  /** Whether the clipboard currently holds text. */
  hasText: boolean
  /** Whether the clipboard currently holds an image (desktop only; `false` in a browser). */
  hasImage: boolean
  /** The clipboard text, or `""` when it holds none. */
  content: string
}

export interface ClipboardImageResult {
  ok: true
  /** Base64-encoded image bytes as the OS handed them over (PNG on every desktop platform). */
  base64: string
  mimeType: "image/png"
  byteLength: number
}

export interface ClipboardWriteResult {
  ok: true
  /** Characters written. */
  length: number
}

export type ClipboardToolResult =
  | ClipboardStatusResult
  | ClipboardImageResult
  | ClipboardWriteResult
  | { ok: true }
  | ClipboardFailure

function failure(err: unknown): ClipboardFailure {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/** Browser-safe base64 (no `Buffer`), chunked so large images do not blow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export async function readClipboardStatus(
  clipboard: ClipboardAPI
): Promise<ClipboardStatusResult | ClipboardFailure> {
  try {
    const [hasText, hasImage] = await Promise.all([clipboard.hasText(), clipboard.hasImage()])
    const content = hasText ? await clipboard.readText() : ""
    return { ok: true, hasText, hasImage, content }
  } catch (err) {
    return failure(err)
  }
}

export async function readClipboardImage(
  clipboard: ClipboardAPI
): Promise<ClipboardImageResult | ClipboardFailure> {
  try {
    const bytes = await clipboard.readImage()
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, error: "The clipboard holds no image." }
    }
    return {
      ok: true,
      base64: bytesToBase64(bytes),
      mimeType: "image/png",
      byteLength: bytes.byteLength,
    }
  } catch (err) {
    return failure(err)
  }
}

export async function writeClipboardText(
  clipboard: ClipboardAPI,
  text: unknown
): Promise<ClipboardWriteResult | ClipboardFailure> {
  if (typeof text !== "string") {
    return { ok: false, error: "`text` must be a string." }
  }
  try {
    await clipboard.writeText(text)
    return { ok: true, length: text.length }
  } catch (err) {
    return failure(err)
  }
}

export async function clearClipboard(
  clipboard: ClipboardAPI
): Promise<{ ok: true } | ClipboardFailure> {
  try {
    await clipboard.clear()
    return { ok: true }
  } catch (err) {
    return failure(err)
  }
}

/** The executable half of the `tools[]` rows declared in `plugin.json`. */
export function createClipboardTools(clipboard: ClipboardAPI): PluginToolRegistration[] {
  return [
    definePluginTool({
      name: "clipboard_status",
      definition: {
        name: "clipboard_status",
        description:
          "Report what the clipboard holds (text and/or image) and return the current clipboard text.",
        category: "clipboard",
        access: "read",
        retryable: true,
        parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async () => readClipboardStatus(clipboard),
    }),
    definePluginTool({
      name: "clipboard_read_image",
      definition: {
        name: "clipboard_read_image",
        description:
          "Read the image currently on the clipboard as base64 PNG. Desktop only; a browser shell has no image clipboard.",
        category: "clipboard",
        access: "read",
        retryable: true,
        parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async () => readClipboardImage(clipboard),
    }),
    definePluginTool({
      name: "clipboard_write_text",
      definition: {
        name: "clipboard_write_text",
        description: "Replace the clipboard contents with the given text.",
        category: "clipboard",
        access: "write",
        parametersSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to place on the clipboard." },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      execute: async (args) => writeClipboardText(clipboard, args.text),
    }),
    definePluginTool({
      name: "clipboard_clear",
      definition: {
        name: "clipboard_clear",
        description: "Empty the clipboard.",
        category: "clipboard",
        access: "write",
        parametersSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      execute: async () => clearClipboard(clipboard),
    }),
  ]
}

/** Workflow nodes; the host prefixes each `kind` with the plugin id. */
export function createClipboardWorkflowNodes(clipboard: ClipboardAPI): PluginNodeDef[] {
  return [
    defineWorkflowNode({
      kind: "action.readText",
      typeVersion: 1,
      category: "plugin",
      label: "Read clipboard text",
      description: "Read the current OS or browser clipboard text.",
      iconName: "Clipboard",
      keywords: ["clipboard", "pasteboard", "copy", "text", "read"],
      paramsSchema: { type: "object", properties: {}, additionalProperties: false },
      defaultParams: {},
      retryable: false,
      execute: async () => ({ output: await readClipboardStatus(clipboard) }),
    }),
    defineWorkflowNode({
      kind: "action.writeText",
      typeVersion: 1,
      category: "plugin",
      label: "Write clipboard text",
      description: "Replace the OS or browser clipboard text with the given value.",
      iconName: "ClipboardCopy",
      keywords: ["clipboard", "pasteboard", "copy", "text", "write", "set"],
      paramsSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to place on the clipboard." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      defaultParams: { text: "" },
      retryable: false,
      execute: async ({ params }) => ({ output: await writeClipboardText(clipboard, params.text) }),
    }),
    defineWorkflowNode({
      kind: "action.clear",
      typeVersion: 1,
      category: "plugin",
      label: "Clear clipboard",
      description: "Empty the OS or browser clipboard.",
      iconName: "ClipboardX",
      keywords: ["clipboard", "pasteboard", "clear", "empty"],
      paramsSchema: { type: "object", properties: {}, additionalProperties: false },
      defaultParams: {},
      retryable: false,
      execute: async () => ({ output: await clearClipboard(clipboard) }),
    }),
  ]
}

let disposeWorkflowNodes: Array<() => void> = []

const definition = definePlugin({
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop the declared
  // `tools[]` / `permissionJustifications`.
  manifest: manifestJson as unknown as PluginManifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger.info("clipboard-tools activated")
    for (const dispose of disposeWorkflowNodes) dispose()
    disposeWorkflowNodes = []
    for (const tool of createClipboardTools(ctx.clipboard)) {
      ctx.agent.registerTool(tool)
    }
    disposeWorkflowNodes = createClipboardWorkflowNodes(ctx.clipboard).map((node) =>
      ctx.workflow.registerNode(node)
    )
  },
  deactivate: async () => {
    // Tools are unregistered by the runtime when deactivate runs; workflow
    // nodes are owned by the disposers the host handed back.
    for (const dispose of disposeWorkflowNodes) dispose()
    disposeWorkflowNodes = []
  },
})

export default definition
