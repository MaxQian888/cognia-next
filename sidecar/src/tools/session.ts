// Session-owned state shared by the two agent rails and external tool hosts.
// Resolver refresh preserves read/task/process state when a paused lease changes
// its tool options; final disposal owns both resolver and process cleanup.
import { makeLazyLspResolver } from "../services/lsp/lazy-resolver.ts"
import { makeLazyCodeGraphResolver } from "../services/code-graph/lazy-resolver.ts"
import { createReadTracker } from "./state/read-tracker.ts"
import { createSessionTaskStore } from "./state/tasks.ts"
import { createSessionBgShellRegistry } from "./state/host-background-shells.ts"
import { disposeTerminalRepls } from "./builtin/terminal-repl/index.ts"
import type { HostRpcCaller } from "./state/host-background-shells.ts"

export type ToolSessionSendOptions = Parameters<typeof makeLazyLspResolver>[0]["sendOptions"] &
  Parameters<typeof makeLazyCodeGraphResolver>[0]["sendOptions"] & {
    backgroundProcessHost?: string | undefined
  }

export interface ToolSessionOptions {
  sendOptions: ToolSessionSendOptions
  sessionId: string
  hostRpc?: HostRpcCaller | null | undefined
  log?: (level: "info" | "warn" | "error", message: string) => void
}

const factories = {
  createReadTracker,
  createSessionTaskStore,
  createSessionBgShellRegistry,
  makeLazyLspResolver,
  makeLazyCodeGraphResolver,
  disposeTerminalRepls,
}

export function createToolSessionContext(
  { sendOptions, sessionId, hostRpc, log = () => {} }: ToolSessionOptions,
  dependencies: typeof factories = factories
) {
  const readTracker = dependencies.createReadTracker()
  const taskStore = dependencies.createSessionTaskStore()
  const bgShells = dependencies.createSessionBgShellRegistry({
    hostRpc,
    sessionId,
    backgroundProcessHost: sendOptions.backgroundProcessHost,
  })
  let lsp = dependencies.makeLazyLspResolver({ sendOptions, log })
  let codeGraph = dependencies.makeLazyCodeGraphResolver({ sendOptions, log })
  let resolversDisposed = false
  let processesDisposed: Promise<void> | undefined

  function disposeResolvers() {
    if (resolversDisposed) return
    resolversDisposed = true
    try {
      lsp.dispose()
    } finally {
      codeGraph.dispose()
    }
  }

  function disposeProcesses(): Promise<void> {
    processesDisposed ??= (async () => {
      try {
        dependencies.disposeTerminalRepls(sessionId)
      } finally {
        await bgShells.killAll()
      }
    })()
    return processesDisposed
  }

  return {
    readTracker,
    taskStore,
    bgShells,
    get lsp() {
      return lsp
    },
    get codeGraph() {
      return codeGraph
    },
    toolContext() {
      return {
        readTracker,
        taskStore,
        bgShells,
        hostRpc,
        sessionId,
        lspResolver: lsp.lspResolver,
        codeGraphResolver: codeGraph.codeGraphResolver,
      }
    },
    refreshResolvers(nextSendOptions: ToolSessionSendOptions) {
      disposeResolvers()
      lsp = dependencies.makeLazyLspResolver({ sendOptions: nextSendOptions, log })
      codeGraph = dependencies.makeLazyCodeGraphResolver({ sendOptions: nextSendOptions, log })
      resolversDisposed = false
    },
    disposeResolvers,
    disposeProcesses,
    async dispose() {
      try {
        disposeResolvers()
      } finally {
        await disposeProcesses()
      }
    },
  }
}

export type ToolSessionContext = ReturnType<typeof createToolSessionContext>
