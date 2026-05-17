/**
 * `vscode.authentication` — OAuth providers + session management.
 *
 * Routes through the renderer's `lib/plugin/auth/auth-provider-registry.ts`.
 */

import { Disposable, EventEmitter } from "./types"
import type { ShimDependencies } from "./index"

export function createAuthenticationNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  const sessionsChanged = new EventEmitter<unknown>()
  connection.onNotification(`authentication:${extensionId}:sessionsChanged`, (data) =>
    sessionsChanged.fire(data)
  )

  return {
    getSession(providerId: string, scopes: string[], options?: Record<string, unknown>) {
      return connection.sendRequest("authentication:getSession", {
        extensionId,
        providerId,
        scopes,
        options,
      })
    },
    getAccounts(providerId: string) {
      return connection.sendRequest("authentication:getAccounts", { extensionId, providerId })
    },
    registerAuthenticationProvider(
      providerId: string,
      label: string,
      provider: {
        getSessions: (scopes: string[] | undefined) => unknown
        createSession: (scopes: string[]) => unknown
        removeSession: (sessionId: string) => unknown
      }
    ) {
      const tokens = {
        getSessions: `auth:${extensionId}:${providerId}:getSessions`,
        createSession: `auth:${extensionId}:${providerId}:createSession`,
        removeSession: `auth:${extensionId}:${providerId}:removeSession`,
      }
      registerProviderCallback(tokens.getSessions, (p) =>
        provider.getSessions((p as { scopes: string[] }).scopes)
      )
      registerProviderCallback(tokens.createSession, (p) =>
        provider.createSession((p as { scopes: string[] }).scopes)
      )
      registerProviderCallback(tokens.removeSession, (p) =>
        provider.removeSession((p as { sessionId: string }).sessionId)
      )
      void connection.sendRequest("authentication:registerProvider", {
        extensionId,
        providerId,
        label,
        tokens,
      })
      return new Disposable(() => {
        void connection.sendNotification("authentication:unregisterProvider", {
          extensionId,
          providerId,
        })
      })
    },
    onDidChangeSessions: sessionsChanged.event,
  }
}
