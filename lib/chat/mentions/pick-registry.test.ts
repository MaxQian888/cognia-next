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
    stageRemoteDoc: jest.fn().mockResolvedValue(null),
    stageEntity: jest.fn().mockResolvedValue({ kind: "entity" }),
    recordMention: jest.fn(),
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
    for (const kind of [
      "file",
      "agent",
      "subagent",
      "skill",
      "preset",
      "wfElement",
      "doc",
      "entity",
    ] as const) {
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

// ---------------------------------------------------------------------------
// Chip-style picks. They leave NO token in the message text, so
// `resolve-mentions.ts` can never recover them by re-parsing. Their citations
// are read at send time off what they staged: the context chip
// (`selection-citations.ts`) or the attachment (`attachment-citations.ts`).
// ---------------------------------------------------------------------------

const docItem = {
  kind: "doc",
  providerId: "lark",
  accountId: "acct_1",
  doc: { id: "doc_1", kind: "doc", title: "Release plan", url: "https://x.feishu.cn/docx/doc_1" },
} as unknown as PopoverItem

const entityItem = {
  kind: "entity",
  candidate: {
    entityKind: "issue",
    id: "iss_1",
    title: "Fix the broker race",
    searchText: "fix the broker race",
  },
} as unknown as PopoverItem

describe("doc picks", () => {
  // The citation rides the staged file and is read off the files a turn
  // submits (`attachment-citations.ts`). Recording it on pick cited fetches
  // that failed and documents whose chip was removed before sending.
  it("stages the document and records no citation of its own", async () => {
    const staged = new File(["body"], "Release plan.md", { type: "text/markdown" })
    const ctx = makeCtx({ stageRemoteDoc: jest.fn().mockResolvedValue(staged) })
    await getMentionPickHandler("doc")!.onPick(docItem as never, ctx)
    expect(ctx.stageRemoteDoc).toHaveBeenCalledWith(docItem)
    expect(ctx.recordMention).not.toHaveBeenCalled()
  })

  it("records nothing when the fetch failed or the gate refused the file", async () => {
    const ctx = makeCtx({ stageRemoteDoc: jest.fn().mockResolvedValue(null) })
    await getMentionPickHandler("doc")!.onPick(docItem as never, ctx)
    expect(ctx.recordMention).not.toHaveBeenCalled()
    expect(ctx.insertReplacement).not.toHaveBeenCalled()
  })

  it("drops the `@lark:…` token before the fetch, so a failure leaves it clean", async () => {
    const ctx = makeCtx()
    await getMentionPickHandler("doc")!.onPick(docItem as never, ctx)
    expect(ctx.removeTriggerToken).toHaveBeenCalled()
  })

  it("stays out of the parameter-eligible set", () => {
    // `toContextRef` answers "may this be a `{{parameter}}` value?", which a
    // staged attachment may not — it contributes no characters at a sentence
    // position. That is a different question from "was it cited?".
    expect(getMentionPickHandler("doc")!.toContextRef(docItem as never)).toBeNull()
  })
})

describe("entity picks", () => {
  // The citation is read off the staged chip at send time, so the handler
  // must not keep a second list that can drift from the chips.
  it("stages the record and records no citation of its own", async () => {
    const ctx = makeCtx()
    await getMentionPickHandler("entity")!.onPick(entityItem as never, ctx)
    expect(ctx.stageEntity).toHaveBeenCalledWith(entityItem)
    expect(ctx.recordMention).not.toHaveBeenCalled()
  })

  it("drops the trigger token before reading", async () => {
    const ctx = makeCtx({ stageEntity: jest.fn().mockResolvedValue(null) })
    await getMentionPickHandler("entity")!.onPick(entityItem as never, ctx)
    expect(ctx.removeTriggerToken).toHaveBeenCalled()
    expect(ctx.insertReplacement).not.toHaveBeenCalled()
  })

  it("stays out of the parameter-eligible set", () => {
    expect(getMentionPickHandler("entity")!.toContextRef(entityItem as never)).toBeNull()
  })

  describe("taken as text", () => {
    const prompt = {
      kind: "entity",
      mode: "text",
      candidate: {
        entityKind: "prompt",
        id: "s1#m1",
        title: "tag the release then push",
        searchText: "",
        insertText: "tag the release\nthen push",
      },
    }

    // The words become part of the new message; nothing about the old one is
    // referenced, so nothing is staged or cited.
    it("puts the words in place of the token and stages nothing", async () => {
      const ctx = makeCtx()
      await getMentionPickHandler("entity")!.onPick(prompt as never, ctx)
      expect(ctx.insertReplacement).toHaveBeenCalledWith("tag the release\nthen push")
      expect(ctx.stageEntity).not.toHaveBeenCalled()
      expect(ctx.removeTriggerToken).not.toHaveBeenCalled()
      expect(ctx.recordMention).not.toHaveBeenCalled()
    })

    it("stages as usual when the record has no words to give", async () => {
      const ctx = makeCtx()
      const item = { ...prompt, candidate: { ...prompt.candidate, insertText: undefined } }
      await getMentionPickHandler("entity")!.onPick(item as never, ctx)
      expect(ctx.insertReplacement).not.toHaveBeenCalled()
      expect(ctx.stageEntity).toHaveBeenCalledWith(item)
    })

    it("stages a prompt picked the ordinary way", async () => {
      const ctx = makeCtx()
      const item = { kind: "entity", candidate: prompt.candidate }
      await getMentionPickHandler("entity")!.onPick(item as never, ctx)
      expect(ctx.stageEntity).toHaveBeenCalledWith(item)
      expect(ctx.insertReplacement).not.toHaveBeenCalled()
    })
  })
})

describe("insertion-style picks record nothing", () => {
  it("leaves a file pick to the text parser", async () => {
    // Its `@src/app.ts` token survives in the message, so recording it here
    // would double-count it against `resolveMentions`.
    const ctx = makeCtx()
    const item = {
      kind: "file",
      entry: { absolutePath: "/w/src/app.ts", relPath: "src/app.ts", isDir: false },
    } as unknown as PopoverItem
    await getMentionPickHandler("file")!.onPick(item as never, ctx)
    expect(ctx.recordMention).not.toHaveBeenCalled()
    expect(ctx.insertReplacement).toHaveBeenCalledWith("@src/app.ts")
  })

  it("leaves session-state picks uncited", async () => {
    // Enabling a skill is not a statement about this message.
    const ctx = makeCtx()
    const item = { kind: "skill", skill: { id: "s1", name: "Reviewer" } } as unknown as PopoverItem
    await getMentionPickHandler("skill")!.onPick(item as never, ctx)
    expect(ctx.recordMention).not.toHaveBeenCalled()
  })
})
