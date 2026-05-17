import { dispatchTrayClick, dispatchShortcut } from "./dispatcher"
import { registerSlashCommand, __resetSlashCommandsForTesting } from "@/lib/slash-commands/registry"
import { registerCommand, __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"

afterEach(() => {
  __resetSlashCommandsForTesting()
  __resetCommandRegistryForTesting()
})

describe("dispatchTrayClick", () => {
  it("returns silently for `native` payloads — Rust handles them", async () => {
    await expect(dispatchTrayClick({ kind: "native", action: "show" })).resolves.toBeUndefined()
  })

  it("returns silently when no payload is supplied (defensive)", async () => {
    await expect(dispatchTrayClick(undefined)).resolves.toBeUndefined()
  })

  it("routes `slash` payloads through dispatchSlashCommand with a leading slash", async () => {
    const handler = jest.fn(() => ({ message: "ok" }))
    registerSlashCommand({ id: "goal", name: "goal", handler })
    await dispatchTrayClick({ kind: "slash", command: "goal" })
    expect(handler).toHaveBeenCalledWith("", undefined)
  })

  it("routes already-prefixed slash payloads correctly", async () => {
    const handler = jest.fn(() => ({}))
    registerSlashCommand({ id: "clear", name: "clear", handler })
    await dispatchTrayClick({ kind: "slash", command: "/clear" })
    expect(handler).toHaveBeenCalled()
  })

  it("routes `command` payloads through executeCommand when registered", async () => {
    const handler = jest.fn(() => "result")
    registerCommand({
      id: "screenshot.capture",
      pluginId: "shot",
      handler,
    })
    await dispatchTrayClick({
      kind: "command",
      commandId: "screenshot.capture",
    })
    expect(handler).toHaveBeenCalled()
  })

  it("no-ops when the command id isn't registered (warning only)", async () => {
    await expect(
      dispatchTrayClick({ kind: "command", commandId: "missing" })
    ).resolves.toBeUndefined()
  })
})

describe("dispatchShortcut", () => {
  it("no-ops for empty id", async () => {
    await expect(dispatchShortcut("")).resolves.toBeUndefined()
  })

  it("no-ops for built-in tray.* ids (Rust already ran the action)", async () => {
    const handler = jest.fn()
    registerCommand({ id: "tray.show", pluginId: null, handler })
    await dispatchShortcut("tray.show")
    expect(handler).not.toHaveBeenCalled()
  })

  it("invokes the matching command for renderer-bound ids", async () => {
    const handler = jest.fn(() => "ok")
    registerCommand({ id: "goal.pause", pluginId: null, handler })
    await dispatchShortcut("goal.pause")
    expect(handler).toHaveBeenCalled()
  })

  it("no-ops when the id has no registered handler (warning only)", async () => {
    await expect(dispatchShortcut("never.registered")).resolves.toBeUndefined()
  })
})
