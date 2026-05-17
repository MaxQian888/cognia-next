/**
 * `vscode.lm` — language model + MCP server definition providers.
 *
 * Routes through cognia's `ctx.agent.registerMcpServerPreset` /
 * `ctx.aiProvider` / `ctx.agent.registerNativeAnthropicTool`. Extensions
 * get cognia's configured models, NOT their own.
 */

import { Disposable, EventEmitter } from "./types"
import type { ShimDependencies } from "./index"

export function createLmNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  const modelsChanged = new EventEmitter<void>()
  connection.onNotification("lm:modelsChanged", () => modelsChanged.fire(undefined))

  return {
    selectChatModels(selector?: {
      vendor?: string
      family?: string
      version?: string
      id?: string
    }) {
      return connection.sendRequest("lm:selectChatModels", { extensionId, selector })
    },
    sendChatRequest(messages: unknown[], options?: Record<string, unknown>) {
      return connection.sendRequest("lm:sendChatRequest", { extensionId, messages, options })
    },
    registerChatModelProvider(
      id: string,
      provider: { provideLanguageModelResponse: (...args: unknown[]) => unknown }
    ) {
      const token = `lm:${extensionId}:${id}`
      registerProviderCallback(token, (payload) => provider.provideLanguageModelResponse(payload))
      void connection.sendRequest("lm:registerChatModelProvider", { extensionId, id, token })
      return new Disposable(() => {
        void connection.sendNotification("lm:unregisterChatModelProvider", { extensionId, id })
      })
    },
    registerMcpServerDefinitionProvider(
      id: string,
      provider: { provideMcpServerDefinitions: () => unknown }
    ) {
      const token = `mcp:${extensionId}:${id}`
      registerProviderCallback(token, () => provider.provideMcpServerDefinitions())
      void connection.sendRequest("lm:registerMcpServerDefinitionProvider", {
        extensionId,
        id,
        token,
      })
      return new Disposable(() => {
        void connection.sendNotification("lm:unregisterMcpServerDefinitionProvider", {
          extensionId,
          id,
        })
      })
    },
    registerTool(name: string, tool: { invoke: (...args: unknown[]) => unknown }) {
      const token = `lmtool:${extensionId}:${name}`
      registerProviderCallback(token, (payload) => tool.invoke(payload))
      void connection.sendRequest("lm:registerTool", { extensionId, name, token })
      return new Disposable(() => {
        void connection.sendNotification("lm:unregisterTool", { extensionId, name })
      })
    },
    tools: [] as unknown[],
    onDidChangeChatModels: modelsChanged.event,
  }
}
