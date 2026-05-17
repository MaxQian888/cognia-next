/**
 * `vscode.tasks` — task provider registration.
 */

import { Disposable, EventEmitter } from "./types"
import type { ShimDependencies } from "./index"

export function createTasksNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  const startEmitter = new EventEmitter<unknown>()
  const endEmitter = new EventEmitter<unknown>()
  connection.onNotification(`tasks:${extensionId}:start`, (data) => startEmitter.fire(data))
  connection.onNotification(`tasks:${extensionId}:end`, (data) => endEmitter.fire(data))

  return {
    registerTaskProvider(
      type: string,
      provider: {
        provideTasks: () => unknown[] | Promise<unknown[]>
        resolveTask?: (task: unknown) => unknown | Promise<unknown>
      }
    ) {
      const tokens = {
        provideTasks: `tasks:${extensionId}:${type}:provideTasks`,
        resolveTask: `tasks:${extensionId}:${type}:resolveTask`,
      }
      registerProviderCallback(tokens.provideTasks, () => provider.provideTasks())
      if (provider.resolveTask) {
        registerProviderCallback(tokens.resolveTask, (p) => provider.resolveTask!(p))
      }
      void connection.sendRequest("tasks:registerProvider", {
        extensionId,
        type,
        tokens,
        hasResolveTask: Boolean(provider.resolveTask),
      })
      return new Disposable(() => {
        void connection.sendNotification("tasks:unregisterProvider", { extensionId, type })
      })
    },
    fetchTasks(filter?: { type?: string }) {
      return connection.sendRequest("tasks:fetchTasks", { extensionId, filter })
    },
    executeTask(task: unknown) {
      return connection.sendRequest("tasks:executeTask", { extensionId, task })
    },
    onDidStartTask: startEmitter.event,
    onDidEndTask: endEmitter.event,
    taskExecutions: [] as unknown[],
  }
}
