import type { PluginContext, PluginGlanceModuleData, PluginHooks } from "@cognia/plugin-sdk"

import definition, {
  buildModuleData,
  INCREMENT_COMMAND,
  manifest,
  MODULE_ID,
  RESET_COMMAND,
  restoreState,
  STATE_KEY,
} from "./index"

/** A context with just what the plugin uses, and handles to drive it. */
function makeCtx(stored?: unknown) {
  const visibility: Array<(visible: boolean) => void> = []
  const update = jest.fn<void, [string, PluginGlanceModuleData | null]>()
  const storage = new Map<string, unknown>(stored === undefined ? [] : [[STATE_KEY, stored]])
  const ctx = {
    storage: {
      get: jest.fn(async (key: string) => storage.get(key)),
      set: jest.fn(async (key: string, value: unknown) => {
        storage.set(key, value)
      }),
    },
    glance: {
      update,
      onVisibilityChange: jest.fn((_id: string, handler: (visible: boolean) => void) => {
        visibility.push(handler)
        handler(false) // the host calls back at once with the current state
        return () => undefined
      }),
    },
    i18n: {
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key} ${JSON.stringify(params)}` : key,
      formatDate: () => "12:00",
      onLocaleChange: jest.fn(() => () => undefined),
    },
    lifecycle: { onDispose: jest.fn() },
  } as unknown as PluginContext
  const setVisible = (visible: boolean) => visibility.forEach((handler) => handler(visible))
  return { ctx, update, storage, setVisible }
}

async function activate(stored?: unknown) {
  const harness = makeCtx(stored)
  const hooks = (await definition.activate(harness.ctx)) as PluginHooks
  return { ...harness, hooks }
}

describe("manifest", () => {
  it("declares the glance module and the commands its buttons run", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["glance", "commands"]))
    expect(manifest.glanceModules?.map((module) => module.id)).toEqual([MODULE_ID])
    expect(manifest.commands?.map((command) => command.id)).toEqual([
      INCREMENT_COMMAND,
      RESET_COMMAND,
    ])
  })
})

describe("glance module", () => {
  it("publishes once the module is on screen, not before", async () => {
    const { update, setVisible } = await activate({ count: 3, changedAt: 0 })
    expect(update).not.toHaveBeenCalled()
    setVisible(true)
    expect(update).toHaveBeenCalledWith(
      MODULE_ID,
      expect.objectContaining({ summary: 'summary {"count":3}' })
    )
  })

  it("counts and resets through its commands, saving and publishing each change", async () => {
    const { hooks, update, storage } = await activate()
    await expect(hooks.onCommand?.(INCREMENT_COMMAND, [])).resolves.toEqual({ handled: true })
    await hooks.onCommand?.(INCREMENT_COMMAND, [])
    expect(storage.get(STATE_KEY)).toMatchObject({ count: 2 })
    expect(update.mock.lastCall?.[1]?.summary).toBe('summary {"count":2}')

    await hooks.onCommand?.(RESET_COMMAND, [])
    expect(storage.get(STATE_KEY)).toMatchObject({ count: 0 })
  })

  it("declines commands it does not own", async () => {
    const { hooks, update } = await activate()
    await expect(hooks.onCommand?.("someone-else", [])).resolves.toEqual({ handled: false })
    expect(update).not.toHaveBeenCalled()
  })

  it("builds data whose buttons name the manifest's commands", () => {
    const data = buildModuleData(
      { count: 0, changedAt: null },
      (key) => key,
      () => ""
    )
    expect(data.actions?.map((action) => action.command)).toEqual([
      INCREMENT_COMMAND,
      RESET_COMMAND,
    ])
    expect(data.stats?.[1]).toMatchObject({ value: "stat.never" })
  })

  it("starts over from a stored value that is not a counter", () => {
    expect(restoreState({ count: -1 })).toEqual({ count: 0, changedAt: null })
    expect(restoreState("x")).toEqual({ count: 0, changedAt: null })
    expect(restoreState({ count: 4, changedAt: 9 })).toEqual({ count: 4, changedAt: 9 })
  })
})
