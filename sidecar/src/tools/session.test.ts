import test from "node:test"
import assert from "node:assert/strict"
import { createToolSessionContext } from "./session.ts"
import { createReadTracker } from "./state/read-tracker.ts"
import { createSessionTaskStore } from "./state/tasks.ts"
import { createSessionBgShellRegistry } from "./state/host-background-shells.ts"

function fixture() {
  const events: string[] = []
  let generation = 0
  const dependencies: NonNullable<Parameters<typeof createToolSessionContext>[1]> = {
    createReadTracker,
    createSessionTaskStore,
    createSessionBgShellRegistry(options) {
      const registry = createSessionBgShellRegistry(options)
      registry.killAll = () => {
        events.push("shells")
      }
      return registry
    },
    makeLazyLspResolver({ sendOptions }) {
      const current = ++generation
      return {
        lspEnabled: !!sendOptions.lsp?.enabled,
        lspResolver: sendOptions.lsp?.enabled
          ? {
              async request() {
                return current
              },
              async getDiagnostics() {
                return []
              },
            }
          : null,
        dispose() {
          events.push(`lsp:${current}`)
        },
      }
    },
    makeLazyCodeGraphResolver() {
      const current = generation
      return {
        codeGraphEnabled: false,
        codeGraphResolver: null,
        dispose() {
          events.push(`graph:${current}`)
        },
      }
    },
    disposeTerminalRepls(id) {
      events.push(`terminal:${id}`)
    },
  }
  return { events, dependencies }
}

test("session contexts own separate read trackers, tasks and process registries", async () => {
  const a = createToolSessionContext({ sessionId: "a", sendOptions: {} })
  const b = createToolSessionContext({ sessionId: "b", sendOptions: {} })
  assert.notEqual(a.readTracker, b.readTracker)
  assert.notEqual(a.taskStore, b.taskStore)
  assert.notEqual(a.bgShells, b.bgShells)
  assert.equal(a.toolContext().readTracker, a.readTracker)
  assert.equal(a.toolContext().taskStore, a.taskStore)
  assert.equal(a.toolContext().bgShells, a.bgShells)
  assert.equal(a.toolContext().sessionId, "a")
  assert.equal(a.lsp.lspResolver, null)
  assert.equal(a.codeGraph.codeGraphResolver, null)
  await Promise.all([a.dispose(), b.dispose()])
})

test("paused lease refresh replaces resolvers but preserves the session state", async () => {
  const { events, dependencies } = fixture()
  const context = createToolSessionContext({ sessionId: "lease", sendOptions: {} }, dependencies)
  const before = context.toolContext()
  context.refreshResolvers({ cwd: "/workspace", lsp: { enabled: true } })
  const after = context.toolContext()
  assert.equal(after.readTracker, before.readTracker)
  assert.equal(after.taskStore, before.taskStore)
  assert.equal(after.bgShells, before.bgShells)
  assert.equal(context.lsp.lspEnabled, true)
  assert.equal(await after.lspResolver?.request("x", "hover"), 2)
  assert.deepEqual(events, ["lsp:1", "graph:1"])
  await context.dispose()
  assert.deepEqual(events, ["lsp:1", "graph:1", "lsp:2", "graph:2", "terminal:lease", "shells"])
})

test("split and repeated teardown dispose every resource only once", async () => {
  const { events, dependencies } = fixture()
  const context = createToolSessionContext({ sessionId: "session", sendOptions: {} }, dependencies)
  context.disposeResolvers()
  context.disposeResolvers()
  assert.deepEqual(events, ["lsp:1", "graph:1"])
  await Promise.all([context.disposeProcesses(), context.dispose(), context.dispose()])
  assert.deepEqual(events, ["lsp:1", "graph:1", "terminal:session", "shells"])
})

test("one cleanup failure does not skip remaining owned resources", async () => {
  const { events, dependencies } = fixture()
  dependencies.disposeTerminalRepls = () => {
    throw new Error("terminal cleanup")
  }
  const context = createToolSessionContext({ sessionId: "session", sendOptions: {} }, dependencies)
  await assert.rejects(context.dispose(), /terminal cleanup/)
  assert.deepEqual(events, ["lsp:1", "graph:1", "shells"])
})
