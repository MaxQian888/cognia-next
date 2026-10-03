/**
 * Renderer side of `TextEditor` operations and decoration types: the host's
 * `window:editorEdit`, `window:editorInsertSnippet`, `window:revealRange`,
 * `window:setSelections`, `window:setEditorOptions`, and
 * `window:registerDecorationType` / `disposeDecorationType` / `setDecorations`.
 * Each goes to `monaco-bridge.ts`, which owns the editors.
 */

import {
  applyEditorEdit,
  disposeDecorationType,
  insertEditorSnippet,
  registerDecorationType,
  revealEditorRange,
  setDecorations,
  setEditorOptions,
  setEditorSelections,
  type DecorationInstance,
} from "./monaco-bridge"
import type { DecorationRenderOptions } from "./decoration-styles"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"

function object(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  return payload as Record<string, unknown>
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  const value = object(payload)
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

/** Decoration keys are minted by the host as `deco:<extension id>:…`; only that extension may use one. */
function ownKey(key: unknown, context: RpcContext): string {
  if (typeof key !== "string" || !key.startsWith(`deco:${context.pluginId}:`)) {
    throw new Error(`Decoration type ${String(key)} does not belong to ${context.pluginId}`)
  }
  return key
}

export function installVscodeEditorHandlers(): Array<() => void> {
  const disposers: Array<() => void> = []
  const on = (method: string, handler: Parameters<typeof registerMethod>[1]) =>
    disposers.push(registerMethod(method, handler))

  on("window:registerDecorationType", (payload, context) => {
    const value = owned(payload, context)
    registerDecorationType({
      extensionId: context.pluginId,
      key: ownKey(value.key, context),
      options: (value.options ?? {}) as DecorationRenderOptions,
    })
    return null
  })
  on("window:disposeDecorationType", (payload, context) => {
    const value = owned(payload, context)
    disposeDecorationType(ownKey(value.key, context))
    return null
  })
  on("window:setDecorations", (payload, context) => {
    const value = object(payload)
    setDecorations({
      editorId: String(value.editorId),
      typeId: ownKey(value.key, context),
      decorations: Array.isArray(value.decorations)
        ? (value.decorations as DecorationInstance[])
        : [],
    })
    return null
  })
  on("window:editorEdit", (payload) => {
    const value = object(payload)
    return applyEditorEdit({
      editorId: String(value.editorId),
      version: Number(value.version),
      edits: Array.isArray(value.edits) ? (value.edits as never) : [],
      options: (value.options ?? {}) as never,
    })
  })
  on("window:editorInsertSnippet", (payload) => {
    const value = object(payload)
    return insertEditorSnippet({
      editorId: String(value.editorId),
      version: Number(value.version),
      snippet: String(value.snippet ?? ""),
      ranges: Array.isArray(value.ranges) ? (value.ranges as never) : [],
      options: (value.options ?? {}) as never,
    })
  })
  on("window:revealRange", (payload) => {
    const value = object(payload)
    revealEditorRange({
      editorId: String(value.editorId),
      range: value.range as never,
      revealType: Number(value.revealType ?? 0),
    })
    return null
  })
  on("window:setSelections", (payload) => {
    const value = object(payload)
    setEditorSelections({
      editorId: String(value.editorId),
      selections: Array.isArray(value.selections) ? (value.selections as never) : [],
    })
    return null
  })
  on("window:setEditorOptions", (payload) => {
    const value = object(payload)
    setEditorOptions({ editorId: String(value.editorId), options: (value.options ?? {}) as never })
    return null
  })
  return disposers
}
