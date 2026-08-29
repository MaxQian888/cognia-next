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
