import { __TESTING__, isEntrypoint, runMcpServerStdio } from "./standalone-entry"
import { pathToFileURL } from "node:url"
import { DEFAULT_EXTERNAL_BRIDGE_SETTINGS } from "@/types/wiki"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const connectMock = jest.fn()
const stopWorkflowRefreshMock = jest.fn()
const startWorkflowToolRefreshMock = jest.fn()
const createStdioTransportMock = jest.fn()
jest.mock("./server", () => ({
  buildMcpServer: jest.fn(() => ({ connect: (...args: unknown[]) => connectMock(...args) })),
  startWorkflowToolRefresh: (...args: unknown[]) => startWorkflowToolRefreshMock(...args),
}))
jest.mock("./transport-stdio", () => ({
  createStdioTransport: (...args: unknown[]) => createStdioTransportMock(...args),
}))

const { resolveSettingsGetter, bridgedSettingsGetter, standaloneSettingsGetter } = __TESTING__

const originalEnv = { ...process.env }

afterEach(() => {
  // Wipe any env mutations between tests; node mutates process.env in place.
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    process.env[key] = value
  }
})

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined)
  stopWorkflowRefreshMock.mockReset()
  startWorkflowToolRefreshMock.mockReset().mockResolvedValue({
    refresh: jest.fn(),
    stop: stopWorkflowRefreshMock,
  })
  createStdioTransportMock.mockReset().mockReturnValue({ transport: "stdio" })
})

describe("runMcpServerStdio", () => {
  test("starts workflow tool refresh and always stops it after transport closes", async () => {
    await runMcpServerStdio()

    expect(startWorkflowToolRefreshMock).toHaveBeenCalledTimes(1)
    expect(connectMock).toHaveBeenCalledWith({ transport: "stdio" })
    expect(stopWorkflowRefreshMock).toHaveBeenCalledTimes(1)
  })

  test("stops workflow refresh when the MCP transport fails", async () => {
    connectMock.mockRejectedValue(new Error("transport closed unexpectedly"))

    await expect(runMcpServerStdio()).rejects.toThrow("transport closed unexpectedly")
    expect(stopWorkflowRefreshMock).toHaveBeenCalledTimes(1)
  })
})

describe("bridgedSettingsGetter", () => {
  test("parses COGNIA_BRIDGE_SETTINGS JSON and returns it on every call", async () => {
    const payload = { ...DEFAULT_EXTERNAL_BRIDGE_SETTINGS, bridgeEnabled: true }
    process.env.COGNIA_BRIDGE_SETTINGS = JSON.stringify(payload)

    const getter = bridgedSettingsGetter()

    await expect(getter()).resolves.toEqual(payload)
    await expect(getter()).resolves.toEqual(payload)
  })

  test("returns undefined when COGNIA_BRIDGE_SETTINGS is missing", async () => {
    delete process.env.COGNIA_BRIDGE_SETTINGS
    const getter = bridgedSettingsGetter()
    await expect(getter()).resolves.toBeUndefined()
  })

  test("returns undefined when COGNIA_BRIDGE_SETTINGS is malformed JSON", async () => {
    process.env.COGNIA_BRIDGE_SETTINGS = "{not-json"
    const getter = bridgedSettingsGetter()
    await expect(getter()).resolves.toBeUndefined()
  })

  test("treats an empty COGNIA_BRIDGE_SETTINGS as missing", async () => {
    process.env.COGNIA_BRIDGE_SETTINGS = ""
    const getter = bridgedSettingsGetter()
    await expect(getter()).resolves.toBeUndefined()
  })
})

describe("standaloneSettingsGetter", () => {
  test("returns DEFAULT_EXTERNAL_BRIDGE_SETTINGS when COGNIA_DATA_DIR is unset", async () => {
    delete process.env.COGNIA_DATA_DIR
    const getter = standaloneSettingsGetter()
    await expect(getter()).resolves.toEqual(DEFAULT_EXTERNAL_BRIDGE_SETTINGS)
  })

  test("returns DEFAULT settings when reading external-bridge.json fails", async () => {
    process.env.COGNIA_DATA_DIR = "C:/__nonexistent__/cognia-test-data"
    const getter = standaloneSettingsGetter()
    await expect(getter()).resolves.toEqual(DEFAULT_EXTERNAL_BRIDGE_SETTINGS)
  })

  test("reads + parses external-bridge.json from COGNIA_DATA_DIR when present", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-bridge-"))
    const settings = { ...DEFAULT_EXTERNAL_BRIDGE_SETTINGS, bridgeEnabled: true }
    await fs.writeFile(path.join(dir, "external-bridge.json"), JSON.stringify(settings), "utf-8")

    process.env.COGNIA_DATA_DIR = dir
    const getter = standaloneSettingsGetter()
    await expect(getter()).resolves.toEqual(settings)

    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe("resolveSettingsGetter", () => {
  test("returns the bridged getter when COGNIA_BRIDGED=1", () => {
    process.env.COGNIA_BRIDGED = "1"
    process.env.COGNIA_BRIDGE_SETTINGS = JSON.stringify(DEFAULT_EXTERNAL_BRIDGE_SETTINGS)
    const getter = resolveSettingsGetter()
    expect(typeof getter).toBe("function")
  })

  test("returns the bridged getter when COGNIA_BRIDGED='true'", () => {
    process.env.COGNIA_BRIDGED = "true"
    delete process.env.COGNIA_BRIDGE_SETTINGS
    const getter = resolveSettingsGetter()
    expect(typeof getter).toBe("function")
  })

  test("returns the standalone getter for any other value", () => {
    process.env.COGNIA_BRIDGED = "0"
    delete process.env.COGNIA_DATA_DIR
    const getter = resolveSettingsGetter()
    expect(typeof getter).toBe("function")
  })
})

describe("isEntrypoint", () => {
  test("recognizes an ESM bundle launched directly by node", () => {
    const entry = path.resolve("/tmp/cognia-mcp.mjs")
    expect(isEntrypoint(pathToFileURL(entry).href, entry)).toBe(true)
    expect(isEntrypoint(pathToFileURL(entry).href, "/tmp/other.mjs")).toBe(false)
    expect(isEntrypoint(pathToFileURL(entry).href, undefined)).toBe(false)
  })
})
