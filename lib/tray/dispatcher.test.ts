jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(),
  setPref: jest.fn(() => Promise.resolve()),
}))

import { dispatchTrayClick, dispatchShortcut, handleTrayUsageCommand } from "./dispatcher"
import { registerSlashCommand, __resetSlashCommandsForTesting } from "@/lib/slash-commands/registry"
import { registerCommand, __resetCommandRegistryForTesting } from "@/lib/plugin/commands/registry"
import { onTrayUsageRefreshRequest } from "./usage-refresh-bus"
import { useTrayStore, __resetTrayStoreForTesting } from "./store"

afterEach(() => {
  __resetSlashCommandsForTesting()
  __resetCommandRegistryForTesting()
  __resetTrayStoreForTesting()
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

  it("swallows slash-handler failures (warning only)", async () => {
    registerSlashCommand({
      id: "boom",
      name: "boom",
      handler: () => {
        throw new Error("kaput")
      },
    })
    await expect(dispatchTrayClick({ kind: "slash", command: "boom" })).resolves.toBeUndefined()
  })

  it("swallows command-handler failures (warning only)", async () => {
    registerCommand({
      id: "explodes",
      pluginId: null,
      handler: () => {
        throw new Error("kaput")
      },
    })
    await expect(
      dispatchTrayClick({ kind: "command", commandId: "explodes" })
    ).resolves.toBeUndefined()
  })

  it("routes the usage-refresh command to the refresh bus, not the registry", async () => {
    const listener = jest.fn()
    const off = onTrayUsageRefreshRequest(listener)
    await dispatchTrayClick({ kind: "command", commandId: "tray.usage.refresh" })
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it("pins / unpins the displayed subscription via the select command", async () => {
    await dispatchTrayClick({ kind: "command", commandId: "tray.usage.select:anthropic:a1" })
    expect(useTrayStore.getState().display.usageAccountKey).toBe("anthropic:a1")

    await dispatchTrayClick({ kind: "command", commandId: "tray.usage.select:" })
    expect(useTrayStore.getState().display.usageAccountKey).toBeNull()
  })
})

describe("handleTrayUsageCommand", () => {
  it("declines ids outside the tray.usage namespace", () => {
    expect(handleTrayUsageCommand("screenshot.capture")).toBe(false)
    expect(handleTrayUsageCommand("tray.usage.unknown")).toBe(false)
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
