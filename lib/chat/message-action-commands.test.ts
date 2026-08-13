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
