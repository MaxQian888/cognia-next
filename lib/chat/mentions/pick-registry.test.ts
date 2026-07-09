/** @jest-environment jsdom */

const toastSuccessMock = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccessMock(...a) },
}))

import {
  getMentionPickHandler,
  registerMentionPickHandler,
  __resetMentionPickHandlersForTests,
  type MentionPickContext,
} from "./pick-registry"
import type { PopoverItem } from "@/components/chat/composer-popover"

function makeCtx(overrides: Partial<MentionPickContext> = {}): MentionPickContext {
  return {
    insertReplacement: jest.fn(),
    removeTriggerToken: jest.fn(),
    addReferencedPath: jest.fn(),
    toggleEphemeralSkill: jest.fn(),
    addReferencedWorkflowElement: jest.fn(),
    applyPreset: jest.fn().mockResolvedValue(undefined),
    session: null,
    clearWorkflowHighlight: jest.fn(),
    strings: { skillEnabled: (name: string) => `enabled:${name}` },
    ...overrides,
  }
}

beforeEach(() => {
  toastSuccessMock.mockClear()
  __resetMentionPickHandlersForTests()
})

describe("registry surface", () => {
  it("provides handlers for every mention-style kind, none for slash/memory", () => {
    for (const kind of ["file", "agent", "subagent", "skill", "preset", "wfElement"] as const) {
      expect(getMentionPickHandler(kind)).toBeDefined()
    }
    expect(getMentionPickHandler("slash")).toBeUndefined()
    expect(getMentionPickHandler("memory")).toBeUndefined()
  })

  it("throws on duplicate registration", () => {
    expect(() =>
      registerMentionPickHandler({ kind: "file", onPick: () => {}, toContextRef: () => null })
    ).toThrow(/already registered/)
  })

  it("accepts a novel custom kind registration", () => {
    const onPick = jest.fn()
    registerMentionPickHandler({
      kind: "customKind" as never,
      onPick,
      toContextRef: () => ({ kind: "file", id: "x" }),
    })
    expect(getMentionPickHandler("customKind" as never)).toBeDefined()
  })
})

describe("built-in handlers", () => {
  it("file: references the path and inserts @relPath (dir gets a trailing slash)", async () => {
    const ctx = makeCtx()
    const item = {
      kind: "file",
      entry: { absolutePath: "/repo/src", relPath: "src", isDir: true },
    } as unknown as Extract<PopoverItem, { kind: "file" }>
    const handler = getMentionPickHandler("file")!
    await handler.onPick(item, ctx)
    expect(ctx.addReferencedPath).toHaveBeenCalledWith({
      absolute: "/repo/src",
      relative: "src",
      isDir: true,
    })
    expect(ctx.insertReplacement).toHaveBeenCalledWith("@src/")
    expect(handler.toContextRef(item)).toEqual({ kind: "file", id: "src", raw: "@src/" })
  })

  it("agent: inserts @name and yields an agent ref", async () => {
    const ctx = makeCtx()
    const item = { kind: "agent", target: { name: "alice" } } as unknown as Extract<
      PopoverItem,
      { kind: "agent" }
    >
    const handler = getMentionPickHandler("agent")!
    await handler.onPick(item, ctx)
    expect(ctx.insertReplacement).toHaveBeenCalledWith("@alice")
    expect(handler.toContextRef(item)).toMatchObject({ kind: "agent", id: "alice" })
  })

  it("subagent: inserts the unique handle and labels the ref with the display name", async () => {
    const ctx = makeCtx()
    const item = {
      kind: "subagent",
      target: { handle: "code-reviewer", name: "Code Reviewer" },
    } as unknown as Extract<PopoverItem, { kind: "subagent" }>
    const handler = getMentionPickHandler("subagent")!
    await handler.onPick(item, ctx)
    expect(ctx.insertReplacement).toHaveBeenCalledWith("@code-reviewer")
    expect(handler.toContextRef(item)).toMatchObject({
      kind: "subagent",
      id: "code-reviewer",
      label: "Code Reviewer",
    })
  })

  it("skill: toggles, removes the token, toasts — and is NOT a message mention", async () => {
    const ctx = makeCtx()
    const item = { kind: "skill", skill: { id: "sk1", name: "Research" } } as unknown as Extract<
      PopoverItem,
      { kind: "skill" }
    >
    const handler = getMentionPickHandler("skill")!
    await handler.onPick(item, ctx)
    expect(ctx.toggleEphemeralSkill).toHaveBeenCalledWith("sk1")
    expect(ctx.removeTriggerToken).toHaveBeenCalled()
    expect(toastSuccessMock).toHaveBeenCalledWith("enabled:Research")
    expect(handler.toContextRef(item)).toBeNull()
  })

  it("preset: removes the token and applies with the bound session", async () => {
    const session = { id: "s1" } as never
    const ctx = makeCtx({ session })
    const item = { kind: "preset", preset: { id: "p1" } } as unknown as Extract<
      PopoverItem,
      { kind: "preset" }
    >
    const handler = getMentionPickHandler("preset")!
    await handler.onPick(item, ctx)
    expect(ctx.removeTriggerToken).toHaveBeenCalled()
    expect(ctx.applyPreset).toHaveBeenCalledWith({ id: "p1" }, session)
    expect(handler.toContextRef(item)).toBeNull()
  })

  it("wfElement: stages the chip, removes the token, clears the highlight", async () => {
    const ctx = makeCtx()
    const item = {
      kind: "wfElement",
      element: { type: "node", id: "n1", label: "Start", kind: "trigger" },
    } as unknown as Extract<PopoverItem, { kind: "wfElement" }>
    const handler = getMentionPickHandler("wfElement")!
    await handler.onPick(item, ctx)
    expect(ctx.addReferencedWorkflowElement).toHaveBeenCalledWith({
      type: "node",
      id: "n1",
      label: "Start",
      kind: "trigger",
    })
    expect(ctx.removeTriggerToken).toHaveBeenCalled()
    expect(ctx.clearWorkflowHighlight).toHaveBeenCalled()
    expect(handler.toContextRef(item)).toBeNull()
  })
})
