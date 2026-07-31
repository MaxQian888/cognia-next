/**
 * Coverage for `lib/cli-bridge/home.ts`:
 *   - resolveCliHome short-circuits to null outside Tauri.
 *   - A successful IPC round-trip returns the home path; empty / wrong-typed
 *     responses and IPC failures degrade to null (never throw).
 *   - writeCliHomeFile forwards the camelCase args to the Rust command.
 */

import { resolveCliHome, writeCliHomeFile } from "./home"

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@cognia/logging", () => ({ loggers: { tray: { warn: jest.fn() } } }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isTauri } = require("@/lib/tauri") as { isTauri: jest.Mock }

afterEach(() => {
  invoke.mockReset()
  isTauri.mockReset().mockReturnValue(true)
})

describe("resolveCliHome", () => {
  it("returns null without touching invoke when not under Tauri", async () => {
    isTauri.mockReturnValue(false)
    expect(await resolveCliHome()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns the resolved home path from Rust", async () => {
    invoke.mockResolvedValueOnce("/home/dev/.cognia")
    expect(await resolveCliHome()).toBe("/home/dev/.cognia")
    expect(invoke).toHaveBeenCalledWith("resolve_cli_home")
  })

  it("coerces null / empty / wrong-typed responses to null", async () => {
    invoke.mockResolvedValueOnce(null)
    expect(await resolveCliHome()).toBeNull()
    invoke.mockResolvedValueOnce("")
    expect(await resolveCliHome()).toBeNull()
    invoke.mockResolvedValueOnce(42 as unknown)
    expect(await resolveCliHome()).toBeNull()
  })

  it("downgrades IPC failures to null", async () => {
    invoke.mockRejectedValueOnce(new Error("no home"))
    expect(await resolveCliHome()).toBeNull()
  })
})

describe("writeCliHomeFile", () => {
  it("forwards camelCase args to the Rust command", async () => {
    invoke.mockResolvedValueOnce(undefined)
    await writeCliHomeFile("credentials.json", "{}", true)
    expect(invoke).toHaveBeenCalledWith("write_cli_home_file", {
      fileName: "credentials.json",
      content: "{}",
      secret: true,
    })
  })

  it("propagates a write failure", async () => {
    invoke.mockRejectedValueOnce(new Error("disk full"))
    await expect(writeCliHomeFile("config.json", "{}", false)).rejects.toThrow("disk full")
  })
})
