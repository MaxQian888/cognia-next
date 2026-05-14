import { __TESTING__ } from "./standalone-entry"
import { DEFAULT_EXTERNAL_BRIDGE_SETTINGS } from "@/types/wiki"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

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
