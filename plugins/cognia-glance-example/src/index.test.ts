/**
 * @cognia-host-integration-test — beyond the plugin's own behaviour, this
 * checks what it publishes against the host's sanitizer and the manifest
 * against the installer's validator, so it reaches past the public SDK.
 */
import type { PluginContext, PluginGlanceModuleData, PluginHooks } from "@cognia/plugin-sdk"

import { sanitizeGlancePluginData } from "@/lib/glance/plugin-data"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"

import definition, { manifest, MODULE_ID, STATE_KEY, TICK_MS } from "./index"
import manifestJson from "../plugin.json"
import { FOCUS_MS, RESET_COMMAND, TOGGLE_COMMAND } from "./timer"

const NOON = new Date(2026, 9, 11, 12, 0, 0).getTime()

/** The manifest's English bundle, with `{name}` parameters filled in like the host does. */
function english(key: string, params?: Record<string, unknown>): string {
  const template = (manifestJson.i18n.locales.en as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params?.[name] !== undefined ? String(params[name]) : match
  )
}

function fakeT(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

function makeCtx(stored?: unknown, t = fakeT) {
  const visibility: Array<(visible: boolean) => void> = []
  const disposers: Array<() => void> = []
  const update = jest.fn<void, [string, PluginGlanceModuleData | null]>()
  const storage = new Map<string, unknown>(stored === undefined ? [] : [[STATE_KEY, stored]])
  const ctx = {
    pluginId: manifestJson.id,
    logger: { info: jest.fn(), warn: jest.fn() },
    storage: {
      get: jest.fn(async (key: string) => storage.get(key)),
      set: jest.fn(async (key: string, value: unknown) => {
        storage.set(key, value)
      }),
    },
    glance: {
      update,
      onVisibilityChange: jest.fn((id: string, handler: (visible: boolean) => void) => {
        expect(id).toBe(MODULE_ID)
        visibility.push(handler)
        handler(false)
        return () => undefined
      }),
    },
    i18n: {
      t,
      onLocaleChange: jest.fn(() => () => undefined),
    },
    lifecycle: {
      onDispose: jest.fn((dispose: () => void) => {
        disposers.push(dispose)
      }),
      signal: new AbortController().signal,
    },
  } as unknown as PluginContext
  const setVisible = (visible: boolean) => visibility.forEach((handler) => handler(visible))
  const dispose = () => disposers.forEach((fn) => fn())
  return { ctx, update, storage, setVisible, dispose }
}

async function activate(stored?: unknown, t = fakeT) {
  const harness = makeCtx(stored, t)
  const hooks = (await definition.activate(harness.ctx)) as PluginHooks
  return { ...harness, hooks }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(NOON)
})
afterEach(() => jest.useRealTimers())

describe("cognia-glance-example manifest", () => {
  it("is an opt-in example: no startup activation, labelled as an example", () => {
    expect(manifestJson).not.toHaveProperty("activationEvents")
    expect(manifest.activationEvents ?? []).not.toContain("startup")
    expect(manifestJson.name).toContain("(example)")
  })

  it("declares the glance module and the commands its buttons run", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["glance", "commands"]))
    expect(manifestJson.glanceModules).toEqual([
      expect.objectContaining({ id: MODULE_ID, titleKey: "glance.title" }),
    ])
    expect(manifestJson.commands.map((command) => command.id)).toEqual([
      TOGGLE_COMMAND,
      RESET_COMMAND,
    ])
  })

  it("passes validation and ships every key in both locales", () => {
    const result = validatePluginManifest(manifestJson, { governanceMode: "warn" })
    expect(result.valid).toBe(true)
    const en = Object.keys(manifestJson.i18n.locales.en).sort()
    expect(Object.keys(manifestJson.i18n.locales["zh-CN"]).sort()).toEqual(en)
  })
})

describe("cognia-glance-example plugin", () => {
  it("publishes nothing until the module is on screen, then ticks while it is", async () => {
    const { update, setVisible } = await activate()
    expect(update).not.toHaveBeenCalled()

    setVisible(true)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0]).toBe(MODULE_ID)
    expect(update.mock.calls[0][1]?.summary).toBe('summary.idle:{"count":0}')

    jest.advanceTimersByTime(TICK_MS)
    expect(update).toHaveBeenCalledTimes(2)

    setVisible(false)
    jest.advanceTimersByTime(TICK_MS * 4)
    expect(update).toHaveBeenCalledTimes(2)
  })

  it("starts, pauses and resets through its commands, saving the state", async () => {
    const { hooks, update, storage } = await activate()
    await expect(hooks.onCommand?.(TOGGLE_COMMAND, [])).resolves.toEqual({ handled: true })
    expect(update.mock.lastCall?.[1]?.summary).toBe('summary.running:{"minutes":25}')
    expect(storage.get(STATE_KEY)).toMatchObject({ phase: "running", endsAt: NOON + FOCUS_MS })

    jest.setSystemTime(NOON + 10 * 60_000)
    await hooks.onCommand?.(TOGGLE_COMMAND, [])
    expect(update.mock.lastCall?.[1]?.summary).toBe('summary.paused:{"minutes":15}')

    await hooks.onCommand?.(RESET_COMMAND, [])
    expect(storage.get(STATE_KEY)).toMatchObject({ phase: "idle", remainingMs: FOCUS_MS })
  })

  it("declines commands it does not own", async () => {
    const { hooks, update } = await activate()
    await expect(hooks.onCommand?.("other", [])).resolves.toEqual({ handled: false })
    expect(update).not.toHaveBeenCalled()
  })

  it("resumes a session saved before a reload and counts it once it ends", async () => {
    const saved = {
      phase: "running",
      endsAt: NOON + 60_000,
      remainingMs: FOCUS_MS,
      day: "2026-10-11",
      completedToday: 1,
    }
    const { update, setVisible } = await activate(saved)
    setVisible(true)
    expect(update.mock.lastCall?.[1]?.summary).toBe('summary.running:{"minutes":1}')

    jest.advanceTimersByTime(TICK_MS * 4)
    expect(update.mock.lastCall?.[1]?.summary).toBe('summary.idle:{"count":2}')
  })

  it("publishes data the host keeps unchanged, in every state", async () => {
    const { hooks, update, setVisible } = await activate(undefined, english)
    setVisible(true)
    await hooks.onCommand?.(TOGGLE_COMMAND, [])
    await hooks.onCommand?.(TOGGLE_COMMAND, [])
    expect(update.mock.calls.map(([, data]) => data?.summary)).toEqual([
      "Ready · 0 done today",
      "Focusing · 25 min left",
      "Paused · 25 min left",
    ])
    for (const [, data] of update.mock.calls) {
      expect(sanitizeGlancePluginData(data)).toEqual(data)
    }
  })

  it("stops ticking when the plugin is disposed", async () => {
    const { update, setVisible, dispose } = await activate()
    setVisible(true)
    dispose()
    jest.advanceTimersByTime(TICK_MS * 4)
    expect(update).toHaveBeenCalledTimes(1)
  })
})
