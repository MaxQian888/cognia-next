import { resolveMessageActionCommands } from "./message-action-commands"

describe("resolveMessageActionCommands", () => {
  it("produces the same capability-based set independently of the UI surface", () => {
    const commands = resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      canRegenerate: true,
      canReadAloud: true,
      streaming: true,
    })

    expect(commands.map((command) => command.id)).toEqual(
      expect.arrayContaining(["copy", "share", "copyLink", "branch", "regenerate", "readAloud"])
    )
    expect(commands.find((command) => command.id === "branch")?.disabled).toBe(true)
    expect(commands.find((command) => command.id === "truncate")?.destructive).toBe(true)
  })

  it("offers reply only with a conversation to answer into and words to quote", () => {
    const ids = (context: Parameters<typeof resolveMessageActionCommands>[0]) =>
      resolveMessageActionCommands(context).map((command) => command.id)
    expect(ids({ role: "assistant", hasContent: true, hasSession: true })).toContain("reply")
    expect(ids({ role: "user", hasContent: true, hasSession: true })).toContain("reply")
    expect(ids({ role: "assistant", hasContent: false, hasSession: true })).not.toContain("reply")
    expect(ids({ role: "assistant", hasContent: true, hasSession: false })).not.toContain("reply")
  })

  it("does not invent content or session actions", () => {
    expect(
      resolveMessageActionCommands({ role: "user", hasContent: false, hasSession: false })
    ).toEqual([{ id: "bookmark" }])
  })

  it("includes role and host capabilities with their safety flags", () => {
    const user = resolveMessageActionCommands({
      role: "user",
      hasContent: true,
      hasSession: true,
      canEdit: true,
      canBringBack: true,
      canDelete: true,
      streaming: false,
    })
    expect(user.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["edit", "bringBack", "delete", "branch", "truncate"])
    )
    expect(user.find(({ id }) => id === "delete")?.destructive).toBe(true)
    expect(user.find(({ id }) => id === "branch")?.disabled).toBe(false)

    const assistant = resolveMessageActionCommands({
      role: "assistant",
      hasContent: false,
      hasSession: false,
      canRegenerate: true,
      streaming: false,
    })
    expect(assistant).toContainEqual({ id: "regenerate", disabled: false })
    expect(assistant.some(({ id }) => id === "edit")).toBe(false)
  })
})

describe("rerunTemplate", () => {
  const base = { role: "user" as const, hasContent: true, hasSession: true }

  it("is offered on a user turn that recorded its parameters", () => {
    const ids = resolveMessageActionCommands({ ...base, canRerunTemplate: true }).map((c) => c.id)
    expect(ids).toContain("rerunTemplate")
  })

  it("is absent on a turn with nothing recorded", () => {
    expect(resolveMessageActionCommands(base).map((c) => c.id)).not.toContain("rerunTemplate")
  })

  // On the answer it would read as "regenerate", which is a different command.
  it("is absent on an assistant turn", () => {
    const ids = resolveMessageActionCommands({
      ...base,
      role: "assistant",
      canRerunTemplate: true,
    }).map((c) => c.id)
    expect(ids).not.toContain("rerunTemplate")
  })

  it("is disabled while the turn is streaming", () => {
    const command = resolveMessageActionCommands({
      ...base,
      canRerunTemplate: true,
      streaming: true,
    }).find((c) => c.id === "rerunTemplate")
    expect(command?.disabled).toBe(true)
  })
})

describe("saveAsIssue", () => {
  const base = { role: "assistant" as const, hasContent: true, hasSession: true }
  const ids = (over = {}) => resolveMessageActionCommands({ ...base, ...over }).map((c) => c.id)

  it("is offered on an assistant turn with content, never on the user's own", () => {
    expect(ids({ canSaveAsIssue: true })).toContain("saveAsIssue")
    expect(ids()).not.toContain("saveAsIssue")
    expect(ids({ role: "user", canSaveAsIssue: true })).not.toContain("saveAsIssue")
    expect(ids({ hasContent: false, canSaveAsIssue: true })).not.toContain("saveAsIssue")
  })

  it("is disabled mid-stream", () => {
    const command = resolveMessageActionCommands({
      ...base,
      canSaveAsIssue: true,
      streaming: true,
    }).find((c) => c.id === "saveAsIssue")
    expect(command?.disabled).toBe(true)
  })
})

describe("saveAsMemory", () => {
  const base = { role: "assistant" as const, hasContent: true, hasSession: true }
  const ids = (over = {}) => resolveMessageActionCommands({ ...base, ...over }).map((c) => c.id)

  it("is offered on an assistant turn that can be saved", () => {
    expect(ids({ canSaveAsMemory: true })).toContain("saveAsMemory")
  })

  it("is absent without the capability", () => {
    expect(ids()).not.toContain("saveAsMemory")
  })

  // A user's own message is already theirs to save with `/remember`; what had
  // no path is the thing the AGENT worked out.
  it("is never offered on the user's own turn", () => {
    expect(ids({ role: "user", canSaveAsMemory: true })).not.toContain("saveAsMemory")
  })

  it("is absent for a turn with nothing in it", () => {
    expect(ids({ hasContent: false, canSaveAsMemory: true })).not.toContain("saveAsMemory")
  })

  it("is disabled mid-stream", () => {
    const command = resolveMessageActionCommands({
      ...base,
      canSaveAsMemory: true,
      streaming: true,
    }).find((c) => c.id === "saveAsMemory")
    expect(command?.disabled).toBe(true)
  })
})

describe("select", () => {
  const ids = (over: Partial<Parameters<typeof resolveMessageActionCommands>[0]> = {}) =>
    resolveMessageActionCommands({
      role: "assistant",
      hasContent: true,
      hasSession: true,
      ...over,
    }).map((c) => c.id)

  it("is offered by a surface that mounts selection mode, on either role", () => {
    expect(ids({ canSelect: true })).toContain("select")
    expect(ids({ role: "user", canSelect: true })).toContain("select")
  })

  // The mobile sheet does not pass the capability, so it offers no row that
  // would open nothing.
  it("is absent without the capability", () => {
    expect(ids()).not.toContain("select")
  })

  it("needs a conversation to act on, not words", () => {
    expect(ids({ hasSession: false, canSelect: true })).not.toContain("select")
    expect(ids({ hasContent: false, canSelect: true })).toContain("select")
  })
})
