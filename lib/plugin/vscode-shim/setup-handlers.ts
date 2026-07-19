/**
 * Wire every canonical `vscode.*` RPC method to its renderer-side handler.
 *
 * Called once during VS Code loader bootstrap (idempotent). Keeps the
 * giant method ↔ handler table out of `vscode-loader.ts` so the loader
 * stays focused on lifecycle.
 */

import { registerMethod } from "./rpc-dispatcher"
import {
  handleRegisterChatModelProvider,
  handleRegisterMcpServerDefinitionProvider,
  handleRegisterTool,
  handleSelectChatModels,
  handleSendChatRequest,
  handleUnregisterChatModelProvider,
  handleUnregisterMcpServerDefinitionProvider,
  handleUnregisterTool,
} from "./lm-handler"
import {
  handleChatParticipantRespond,
  handleCreateChatParticipant,
  handleDisposeChatParticipant,
  handleRegisterChatVariableResolver,
  handleUnregisterChatVariableResolver,
} from "./chat-participant-registry"
import {
  handleExtensionCleanup,
  handleLanguagesRegister,
  handleLanguagesRegisterDecorationType,
  handleLanguagesSetDecorations,
  handleLanguagesSetDiagnostics,
  handleLanguagesUnregister,
  handleWindowActiveTextEditorGet,
} from "./languages-handler"
import { vscodeDiagnosticToMonacoMarker, type VscodeDiagnostic } from "./lsp-protocol-adapter"
import { listWorkspaceFolders, resolveWorkspaceFolder } from "./lsp-workspace-manager"
import { listLanguages } from "@/lib/plugin/bridge/languages-bridge"
import {
  cleanupVscodeRuntimeRegistrations,
  installVscodeRuntimeRpcHandlers,
} from "./runtime-handlers"

let installed = false

/**
 * Idempotent registration of every method handler. Returns a disposer
 * primarily for the test suite — production code never tears these down.
 */
export function installVscodeRpcHandlers(): () => void {
  if (installed) return () => {}
  installed = true
  const disposers: Array<() => void> = []

  // lm:* — language model & MCP/tool providers.
  disposers.push(registerMethod("lm:selectChatModels", (p) => handleSelectChatModels(p as never)))
  disposers.push(registerMethod("lm:sendChatRequest", (p) => handleSendChatRequest(p as never)))
  disposers.push(
    registerMethod("lm:registerChatModelProvider", (p) =>
      handleRegisterChatModelProvider(p as never)
    )
  )
  disposers.push(
    registerMethod("lm:unregisterChatModelProvider", (p) => {
      handleUnregisterChatModelProvider(p as never)
    })
  )
  disposers.push(
    registerMethod("lm:registerMcpServerDefinitionProvider", (p) =>
      handleRegisterMcpServerDefinitionProvider(p as never)
    )
  )
  disposers.push(
    registerMethod("lm:unregisterMcpServerDefinitionProvider", (p) => {
      handleUnregisterMcpServerDefinitionProvider(p as never)
    })
  )
  disposers.push(registerMethod("lm:registerTool", (p) => handleRegisterTool(p as never)))
  disposers.push(
    registerMethod("lm:unregisterTool", (p) => {
      handleUnregisterTool(p as never)
    })
  )

  // chat:* — participants & variable resolvers.
  disposers.push(
    registerMethod("chat:createParticipant", (p) => handleCreateChatParticipant(p as never))
  )
  disposers.push(
    registerMethod("chat:disposeParticipant", (p) => handleDisposeChatParticipant(p as never))
  )
  disposers.push(
    registerMethod("chat:registerChatVariableResolver", (p) =>
      handleRegisterChatVariableResolver(p as never)
    )
  )
  // Compatibility alias for early persisted sidecar builds.
  disposers.push(
    registerMethod("chat:registerVariableResolver", (p) =>
      handleRegisterChatVariableResolver(p as never)
    )
  )
  disposers.push(
    registerMethod("chat:unregisterChatVariableResolver", (p) =>
      handleUnregisterChatVariableResolver(p as never)
    )
  )
  disposers.push(
    registerMethod("chat:respond", (p) => {
      handleChatParticipantRespond(p as never)
    })
  )

  // languages:* — provider registration + diagnostics + decorations.
  disposers.push(registerMethod("languages:register", (p) => handleLanguagesRegister(p as never)))
  disposers.push(
    registerMethod("languages:list", () =>
      [...new Set(listLanguages().map((item) => item.id))].sort()
    )
  )
  disposers.push(
    registerMethod("languages:unregister", (p) => handleLanguagesUnregister(p as never))
  )
  disposers.push(
    registerMethod("languages:setDiagnostics", (p) => {
      // Sidecar speaks VS Code shapes; convert each Diagnostic into a
      // Monaco marker (string severity, 1-based ranges) before forwarding
      // to the bridge. Either `diagnostics` (sidecar's collection.set
      // notification) or pre-converted `markers` (renderer-side callers)
      // is accepted.
      const payload = p as {
        extensionId: string
        uri: string
        diagnostics?: VscodeDiagnostic[]
        markers?: unknown[]
      }
      const markers = payload.diagnostics
        ? payload.diagnostics.map(vscodeDiagnosticToMonacoMarker)
        : (payload.markers ?? [])
      handleLanguagesSetDiagnostics({
        extensionId: payload.extensionId,
        uri: payload.uri,
        markers,
      })
    })
  )
  disposers.push(
    registerMethod("languages:clearDiagnostics", (p) => {
      // Sidecar emits this when an extension calls
      // `DiagnosticCollection.set(uri, undefined)` or `.delete(uri)`.
      // Treat as setting the marker list to empty.
      const payload = p as { extensionId: string; uri: string }
      handleLanguagesSetDiagnostics({
        extensionId: payload.extensionId,
        uri: payload.uri,
        markers: [],
      })
    })
  )
  disposers.push(
    registerMethod("languages:registerDecorationType", (p) =>
      handleLanguagesRegisterDecorationType(p as never)
    )
  )
  disposers.push(
    registerMethod("languages:setDecorations", (p) => handleLanguagesSetDecorations(p as never))
  )
  disposers.push(
    registerMethod("extension:cleanup", (p) => {
      const payload = p as { extensionId: string }
      cleanupVscodeRuntimeRegistrations(payload.extensionId)
      return handleExtensionCleanup(payload)
    })
  )
  disposers.push(
    registerMethod("window:activeTextEditor:get", () => handleWindowActiveTextEditorGet())
  )

  disposers.push(...installVscodeRuntimeRpcHandlers())

  // workspace:* — workspace folder lookups for the sidecar's
  // `vscode.workspace.workspaceFolders` / `getWorkspaceFolder(uri)` APIs.
  // Answered by `lsp-workspace-manager` from the renderer side, which
  // tracks materialised per-surface workspaces.
  disposers.push(registerMethod("workspace:listFolders", () => listWorkspaceFolders()))
  disposers.push(
    registerMethod("workspace:getWorkspaceFolder", (p) => {
      const { uri } = p as { uri: string }
      return resolveWorkspaceFolder(uri)
    })
  )

  return () => {
    installed = false
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // disposer is best-effort; ignored.
      }
    }
  }
}
