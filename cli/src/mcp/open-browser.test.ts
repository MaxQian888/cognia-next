/**
 * @jest-environment node
 */
import { EventEmitter } from "node:events"

import { openBrowser, openCommand } from "./open-browser"

describe("openCommand", () => {
  it("uses cmd /c start on Windows with an empty title arg", () => {
    expect(openCommand("win32", "https://x/auth?a=1&b=2")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "https://x/auth?a=1&b=2"],
    })
  })

  it("uses open on macOS", () => {
    expect(openCommand("darwin", "https://x")).toEqual({ cmd: "open", args: ["https://x"] })
  })

  it("uses xdg-open on Linux", () => {
    expect(openCommand("linux", "https://x")).toEqual({ cmd: "xdg-open", args: ["https://x"] })
  })

  it("returns null for an unsupported platform", () => {
    expect(openCommand("aix" as NodeJS.Platform, "https://x")).toBeNull()
  })
})

describe("openBrowser", () => {
  function fakeChild() {
    return new EventEmitter() as EventEmitter & { stdin?: unknown }
  }

  it("resolves true once the opener spawns", async () => {
    const child = fakeChild()
    const spawn = jest.fn(() => child) as never
    const p = openBrowser("https://x", { platform: "darwin", spawn })
    child.emit("spawn")
    await expect(p).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      "open",
      ["https://x"],
      expect.objectContaining({ stdio: "ignore" })
    )
  })

  it("resolves false when the opener errors", async () => {
    const child = fakeChild()
    const p = openBrowser("https://x", { platform: "linux", spawn: (() => child) as never })
    child.emit("error", new Error("xdg-open: not found"))
    await expect(p).resolves.toBe(false)
  })

  it("resolves false on an unsupported platform without spawning", async () => {
    const spawn = jest.fn()
    await expect(
      openBrowser("https://x", { platform: "sunos" as NodeJS.Platform, spawn: spawn as never })
    ).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it("resolves false when spawn throws synchronously", async () => {
    const spawn = (() => {
      throw new Error("EACCES")
    }) as never
    await expect(openBrowser("https://x", { platform: "darwin", spawn })).resolves.toBe(false)
  })
})
