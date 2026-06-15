/**
 * @jest-environment node
 */
import {
  copilotApply,
  copilotCheckProposal,
  copilotCreate,
  copilotDiscard,
  copilotEdit,
  copilotExit,
  copilotSave,
  type CopilotDeps,
} from "./workflow-copilot-controller"
import type { TuiAction } from "../state/types"
import type { ProposalOp } from "@/lib/workflow/editor/proposal-types"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

const fullWf: VisualWorkflow = {
  id: "w1",
  schemaVersion: 2,
  name: "Demo",
  createdAt: 0,
  updatedAt: 0,
  nodes: [],
  edges: [],
  settings: DEFAULT_WORKFLOW_SETTINGS,
}

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

type FakeState = {
  nodes: Array<{ id: string; data?: { kind?: string; label?: string } }>
  edges: Array<{ id: string; source: string; target: string }>
  dirty: boolean
  applyProposalOps: (ops: ReadonlyArray<ProposalOp>) => { applied: number; firstError?: string }
  toWorkflow: () => VisualWorkflow
  markSaved: () => void
}

function fakeStore(over: Partial<FakeState> = {}) {
  const state: FakeState = {
    nodes: [],
    edges: [],
    dirty: false,
    applyProposalOps: jest.fn(() => ({ applied: 2 })),
    toWorkflow: jest.fn(() => fullWf),
    markSaved: jest.fn(),
    ...over,
  }
  return { getState: () => state, state }
}

function fakeProposals(open?: { proposalId: string; summary: string; ops: ProposalOp[] }) {
  const markApplied = jest.fn()
  const discardProposal = jest.fn()
  return {
    api: {
      getState: () => ({ entries: open ? { w1: { open } } : {}, markApplied, discardProposal }),
    } as unknown as NonNullable<CopilotDeps["proposals"]>,
    markApplied,
    discardProposal,
  }
}

const row = { id: "w1", name: "Demo", nodes: [], edges: [] } as never

describe("copilotCreate", () => {
  it("persists a draft, registers a store, enables the plugin, and enters mode", async () => {
    const { dispatch, actions } = recorder()
    const register = jest.fn()
    const ensurePlugin = jest.fn(async () => {})
    await copilotCreate("My flow", {
      dispatch,
      ensureDb: async () => {},
      create: async () => row,
      createStore: () => fakeStore() as never,
      register,
      ensurePlugin,
    })
    expect(register).toHaveBeenCalledWith("w1", expect.anything())
    expect(ensurePlugin).toHaveBeenCalled()
    expect(actions).toEqual([
      { type: "COPILOT_ENTER", workflowId: "w1", name: "Demo", isNew: true },
      expect.objectContaining({ type: "NOTICE" }),
    ])
  })

  it("notices when creation fails", async () => {
    const { dispatch, actions } = recorder()
    await copilotCreate("x", {
      dispatch,
      ensureDb: async () => {},
      create: async () => {
        throw new Error("disk full")
      },
    })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
    expect(actions.some((a) => a.type === "COPILOT_ENTER")).toBe(false)
  })
})

describe("copilotEdit", () => {
  it("enters mode for an existing workflow", async () => {
    const { dispatch, actions } = recorder()
    await copilotEdit("w1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => row,
      createStore: () => fakeStore() as never,
      register: jest.fn(),
      ensurePlugin: async () => {},
    })
    expect(actions[0]).toEqual({
      type: "COPILOT_ENTER",
      workflowId: "w1",
      name: "Demo",
      isNew: false,
    })
  })

  it("notices a missing workflow", async () => {
    const { dispatch, actions } = recorder()
    await copilotEdit("nope", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })

  it("notices on a blank id", async () => {
    const { dispatch, actions } = recorder()
    await copilotEdit("  ", { dispatch })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("copilotCheckProposal", () => {
  const open = {
    proposalId: "p1",
    summary: "Add a step",
    ops: [
      { type: "add_node", nodeId: "n", kind: "ai.prompt", position: { x: 0, y: 0 } },
    ] as ProposalOp[],
  }

  it("opens an Apply/Discard confirm overlay for an open proposal", () => {
    const { dispatch, actions } = recorder()
    const { api } = fakeProposals(open)
    copilotCheckProposal("w1", { dispatch, proposals: api, getStore: () => fakeStore() })
    expect(actions[0]).toEqual({ type: "COPILOT_SET_PROPOSAL", proposalId: "p1" })
    expect(actions[1]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "confirm",
        onConfirmCommand: "workflow apply",
        onCancelCommand: "workflow discard",
      },
    })
  })

  it("does nothing when no proposal was staged", () => {
    const { dispatch, actions } = recorder()
    copilotCheckProposal("w1", { dispatch, proposals: fakeProposals().api })
    expect(actions).toHaveLength(0)
  })
})

describe("copilotApply", () => {
  const open = { proposalId: "p1", summary: "s", ops: [] as ProposalOp[] }

  it("applies, persists, marks applied+saved, and clears", async () => {
    const { dispatch, actions } = recorder()
    const store = fakeStore()
    const { api, markApplied } = fakeProposals(open)
    const replace = jest.fn(async () => {})
    await copilotApply("w1", { dispatch, getStore: () => store, proposals: api, replace })
    expect(store.state.applyProposalOps).toHaveBeenCalled()
    expect(replace).toHaveBeenCalled()
    expect(markApplied).toHaveBeenCalledWith("w1")
    expect(store.state.markSaved).toHaveBeenCalled()
    expect(actions).toContainEqual({ type: "COPILOT_CLEAR_PROPOSAL" })
  })

  it("notices and does not clear when an op fails", async () => {
    const { dispatch, actions } = recorder()
    const store = fakeStore({
      applyProposalOps: jest.fn(() => ({ applied: 0, firstError: "bad" })),
    })
    await copilotApply("w1", {
      dispatch,
      getStore: () => store,
      proposals: fakeProposals(open).api,
      replace: jest.fn(async () => {}),
    })
    expect(actions).toEqual([expect.objectContaining({ type: "NOTICE" })])
  })

  it("notices when there is no open proposal", async () => {
    const { dispatch, actions } = recorder()
    await copilotApply("w1", {
      dispatch,
      getStore: () => fakeStore(),
      proposals: fakeProposals().api,
    })
    expect(actions).toContainEqual({ type: "COPILOT_CLEAR_PROPOSAL" })
  })
})

describe("copilotDiscard", () => {
  it("discards the proposal and clears", () => {
    const { dispatch, actions } = recorder()
    const { api, discardProposal } = fakeProposals({
      proposalId: "p1",
      summary: "s",
      ops: [],
    })
    copilotDiscard("w1", { dispatch, proposals: api })
    expect(discardProposal).toHaveBeenCalledWith("w1")
    expect(actions).toContainEqual({ type: "COPILOT_CLEAR_PROPOSAL" })
  })
})

describe("copilotSave", () => {
  it("persists the draft and marks it saved", async () => {
    const { dispatch, actions } = recorder()
    const store = fakeStore()
    const replace = jest.fn(async () => {})
    await copilotSave("w1", { dispatch, getStore: () => store, replace })
    expect(replace).toHaveBeenCalled()
    expect(store.state.markSaved).toHaveBeenCalled()
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("copilotExit", () => {
  it("saves a dirty draft, unregisters, and exits", async () => {
    const { dispatch, actions } = recorder()
    const store = fakeStore({ dirty: true })
    const replace = jest.fn(async () => {})
    const unregister = jest.fn()
    await copilotExit("w1", { dispatch, getStore: () => store, replace, unregister })
    expect(replace).toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledWith("w1")
    expect(actions).toContainEqual({ type: "COPILOT_EXIT" })
  })

  it("exits without saving when the draft is clean", async () => {
    const { dispatch, actions } = recorder()
    const store = fakeStore({ dirty: false })
    const replace = jest.fn(async () => {})
    await copilotExit("w1", {
      dispatch,
      getStore: () => store,
      replace,
      unregister: jest.fn(),
    })
    expect(replace).not.toHaveBeenCalled()
    expect(actions).toContainEqual({ type: "COPILOT_EXIT" })
  })
})
