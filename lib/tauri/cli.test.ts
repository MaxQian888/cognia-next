/** @jest-environment jsdom */
import { getLaunchCli } from "./cli"

jest.mock("@tauri-apps/plugin-cli", () => ({
  getMatches: jest.fn(),
}))

import { getMatches } from "@tauri-apps/plugin-cli"

const mockedGetMatches = getMatches as jest.MockedFunction<typeof getMatches>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/cli", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setTauri(false)
    warnSpy.mockRestore()
  })

  it("returns nullish defaults outside Tauri", async () => {
    const result = await getLaunchCli()
    expect(result).toEqual({ workspacePath: null, newChat: false })
    expect(mockedGetMatches).not.toHaveBeenCalled()
  })

  it("parses workspace path and newChat flag in Tauri", async () => {
    setTauri(true)
    mockedGetMatches.mockResolvedValue({
      args: {
        workspace: { value: "/path/to/ws", occurrences: 1 },
        "new-chat": { value: true, occurrences: 1 },
      },
      subcommand: null,
    } as unknown as Awaited<ReturnType<typeof getMatches>>)

    const result = await getLaunchCli()
    expect(result).toEqual({ workspacePath: "/path/to/ws", newChat: true })
  })

  it("treats empty string workspace as null", async () => {
    setTauri(true)
    mockedGetMatches.mockResolvedValue({
      args: {
        workspace: { value: "", occurrences: 0 },
        "new-chat": { value: false, occurrences: 0 },
      },
      subcommand: null,
    } as unknown as Awaited<ReturnType<typeof getMatches>>)

    const result = await getLaunchCli()
    expect(result).toEqual({ workspacePath: null, newChat: false })
  })

  it("treats non-string workspace as null", async () => {
    setTauri(true)
    mockedGetMatches.mockResolvedValue({
      args: {
        workspace: { value: 123 as unknown as string, occurrences: 0 },
        "new-chat": { value: false, occurrences: 0 },
      },
      subcommand: null,
    } as unknown as Awaited<ReturnType<typeof getMatches>>)

    const result = await getLaunchCli()
    expect(result.workspacePath).toBeNull()
    expect(result.newChat).toBe(false)
  })

  it("returns false for newChat when value is not strictly true", async () => {
    setTauri(true)
    mockedGetMatches.mockResolvedValue({
      args: {
        workspace: { value: "/x", occurrences: 1 },
        "new-chat": { value: "true" as unknown as boolean, occurrences: 1 },
      },
      subcommand: null,
    } as unknown as Awaited<ReturnType<typeof getMatches>>)

    const result = await getLaunchCli()
    expect(result.newChat).toBe(false)
  })

  it("handles missing args entries with optional chaining", async () => {
    setTauri(true)
    mockedGetMatches.mockResolvedValue({
      args: {},
      subcommand: null,
    } as unknown as Awaited<ReturnType<typeof getMatches>>)

    const result = await getLaunchCli()
    expect(result).toEqual({ workspacePath: null, newChat: false })
  })

  it("logs and returns defaults when getMatches rejects", async () => {
    setTauri(true)
    mockedGetMatches.mockRejectedValue(new Error("nope"))
    const result = await getLaunchCli()
    expect(result).toEqual({ workspacePath: null, newChat: false })
    expect(warnSpy).toHaveBeenCalledWith("getLaunchCli failed", expect.any(Error))
  })
})
