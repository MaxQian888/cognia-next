/**
 * `vscode.chat` — chat participants + variable resolvers.
 *
 * Each participant becomes a virtual cognia Character.
 */

import { Disposable } from "./types"
import type { ShimDependencies } from "./index"

export function createChatNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  return {
    createChatParticipant(
      id: string,
      handler: (request: unknown, context: unknown, stream: unknown, token: unknown) => unknown
    ) {
      const token = `chat:${extensionId}:${id}`
      registerProviderCallback(token, (payload) => {
        const p = payload as { request: unknown; context: unknown; stream: unknown; token: unknown }
        return handler(p.request, p.context, p.stream, p.token)
      })
      void connection.sendRequest("chat:createParticipant", { extensionId, id, token })
      return {
        id,
        fullName: id,
        name: id,
        iconPath: undefined as unknown,
        followupProvider: undefined as unknown,
        onDidReceiveFeedback: () => new Disposable(() => {}),
        dispose: () => {
          void connection.sendNotification("chat:disposeParticipant", { extensionId, id })
        },
      }
    },
    registerChatVariableResolver(
      id: string,
      resolver: { resolve: (...args: unknown[]) => unknown }
    ) {
      const token = `chatVar:${extensionId}:${id}`
      registerProviderCallback(token, (payload) => resolver.resolve(payload))
      void connection.sendRequest("chat:registerChatVariableResolver", {
        extensionId,
        id,
        token,
      })
      return new Disposable(() => {
        void connection.sendNotification("chat:unregisterChatVariableResolver", {
          extensionId,
          id,
        })
      })
    },
  }
}
