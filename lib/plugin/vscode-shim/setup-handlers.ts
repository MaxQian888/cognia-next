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
} from "./chat-participant-registry"

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
    registerMethod("chat:registerVariableResolver", (p) =>
      handleRegisterChatVariableResolver(p as never)
    )
  )
  disposers.push(
    registerMethod("chat:respond", (p) => {
      handleChatParticipantRespond(p as never)
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
