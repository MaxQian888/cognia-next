jest.mock("@cognia/logging", () => ({ loggers: { plugin: { warn: jest.fn() } } }))

import type { CogsetStateRow } from "@/types/plugin/plugin-cogset"

import { startCogsetFollower, type CogsetFollowerDeps } from "./follower"

function harness(options: {
  state?: Partial<CogsetStateRow>
  existing?: string[]
  workspace?: { workspaceId: string | null; cogsetId?: string }
  runs?: boolean
}) {
  let state: CogsetStateRow = { id: "host", alwaysOn: [], updatedAt: 0, ...options.state }
  let override: string | undefined
  let workspace = options.workspace ?? { workspaceId: null }
  let runs = !!options.runs
  const listeners = { session: () => {}, workspace: () => {}, state: () => {}, runs: () => {} }
  const activated: string[] = []
  const deps: CogsetFollowerDeps = {
    getSessionOverride: () => override,
    clearSessionOverride: () => {
      override = undefined
    },
    subscribeSession: (l) => ((listeners.session = l), () => {}),
    getWorkspace: () => workspace,
    subscribeWorkspace: (l) => ((listeners.workspace = l), () => {}),
    getState: async () => state,
    subscribeState: (l) => ((listeners.state = l), () => {}),
    updateState: async (patch) => {
      state = { ...state, ...patch }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (state as unknown as Record<string, unknown>)[key]
      }
    },
    cogsetExists: async (id) => (options.existing ?? ["a", "b", "w", "s"]).includes(id),
    runsInFlight: () => runs,
    subscribeRuns: (l) => ((listeners.runs = l), () => {}),
    activate: async (id) => {
      activated.push(id)
      state = { ...state, appliedCogsetId: id }
    },
    activationTarget: () => null,
    now: () => 7,
  }
  const follower = startCogsetFollower(deps)
  return {
    follower,
    activated,
    listeners,
    state: () => state,
    setOverride: (id: string | undefined) => {
      override = id
      listeners.session()
    },
    setWorkspace: (next: typeof workspace) => {
      workspace = next
      listeners.workspace()
    },
    setGlobal: (id: string) => {
      state = { ...state, globalCogsetId: id }
      listeners.state()
    },
    setRuns: (next: boolean) => {
      runs = next
      listeners.runs()
    },
    override: () => override,
  }
}

describe("cogset follower", () => {
  it("activates the global cogset when it differs from the applied one", async () => {
    const h = harness({ state: { globalCogsetId: "b", appliedCogsetId: "a" } })
    await h.follower.evaluate()
    expect(h.activated).toEqual(["b"])
  })

  it("does nothing when the effective cogset is already applied", async () => {
    const h = harness({ state: { globalCogsetId: "a", appliedCogsetId: "a" } })
    await h.follower.evaluate()
    expect(h.activated).toEqual([])
  })

  it("follows the workspace binding and returns to the global choice without one", async () => {
    const h = harness({ state: { globalCogsetId: "a", appliedCogsetId: "a" } })
    h.setWorkspace({ workspaceId: "p1", cogsetId: "w" })
    await h.follower.evaluate()
    h.setWorkspace({ workspaceId: "p2" })
    await h.follower.evaluate()
    expect(h.activated).toEqual(["w", "a"])
  })

  it("a workspace change clears the session override", async () => {
    const h = harness({
      state: { globalCogsetId: "a", appliedCogsetId: "a" },
      workspace: { workspaceId: "p1", cogsetId: "w" },
    })
    h.setOverride("s")
    await h.follower.evaluate()
    expect(h.activated.at(-1)).toBe("s")
    h.setWorkspace({ workspaceId: "p2", cogsetId: "w" })
    await h.follower.evaluate()
    expect(h.override()).toBeUndefined()
    expect(h.activated.at(-1)).toBe("w")
  })

  it("defers while runs are in flight, records pending, and switches once they settle", async () => {
    const h = harness({ state: { globalCogsetId: "a", appliedCogsetId: "a" }, runs: true })
    h.setGlobal("b")
    await h.follower.evaluate()
    expect(h.activated).toEqual([])
    expect(h.state().pending).toEqual({ cogsetId: "b", reason: "runs-in-flight", since: 7 })

    h.setRuns(false)
    await h.follower.evaluate()
    expect(h.activated).toEqual(["b"])
    expect(h.state().pending).toBeUndefined()
  })

  it("clears a stale pending switch once nothing needs to change", async () => {
    const h = harness({
      state: {
        globalCogsetId: "a",
        appliedCogsetId: "a",
        pending: { cogsetId: "b", reason: "runs-in-flight", since: 1 },
      },
    })
    await h.follower.evaluate()
    expect(h.state().pending).toBeUndefined()
  })

  it("ignores references to deleted cogsets", async () => {
    const h = harness({ state: { globalCogsetId: "gone", appliedCogsetId: "a" }, existing: ["a"] })
    await h.follower.evaluate()
    expect(h.activated).toEqual([])
  })

  it("stops evaluating after stop()", async () => {
    const h = harness({ state: { appliedCogsetId: "a" } })
    await h.follower.evaluate()
    h.follower.stop()
    h.setGlobal("b")
    await h.follower.evaluate()
    expect(h.activated).toEqual([])
  })
})
