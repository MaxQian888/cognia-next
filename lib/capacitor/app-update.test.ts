/** @jest-environment jsdom */
import {
  completeFlexibleUpdate,
  getAppUpdateInfo,
  openAppStore,
  performImmediateUpdate,
  startFlexibleUpdate,
  subscribeFlexibleUpdateDownloaded,
} from "./app-update"

function loader(overrides: Record<string, unknown> = {}) {
  return async () =>
    ({
      getAppUpdateInfo: async () => ({
        updateAvailability: 2,
        currentVersionName: "1.0.0",
        availableVersionName: "2.0.0",
        flexibleUpdateAllowed: true,
        immediateUpdateAllowed: false,
        clientVersionStalenessDays: 7,
      }),
      startFlexibleUpdate: async () => ({ code: 0 }),
      addListener: async () => ({ remove: async () => {} }),
      completeFlexibleUpdate: async () => undefined,
      performImmediateUpdate: async () => ({ code: 0 }),
      openAppStore: async () => undefined,
      ...overrides,
    }) as never
}

const missing = async () => {
  throw new Error("plugin not installed")
}

describe("getAppUpdateInfo", () => {
  it("maps Play's availability codes onto names", async () => {
    const out = await getAppUpdateInfo(loader())
    expect(out).toMatchObject({
      kind: "ok",
      value: {
        availability: "available",
        availableVersionName: "2.0.0",
        flexibleAllowed: true,
        immediateAllowed: false,
        clientVersionStalenessDays: 7,
      },
    })
  })

  it("names an unknown code rather than assuming an update exists", async () => {
    const out = await getAppUpdateInfo(
      loader({ getAppUpdateInfo: async () => ({ updateAvailability: 99 }) })
    )
    expect(out).toMatchObject({ kind: "ok", value: { availability: "unknown" } })
  })

  it("reports unsupported off Android instead of throwing", async () => {
    expect(await getAppUpdateInfo(missing as never)).toEqual({ kind: "unsupported" })
  })
})

describe("update flows", () => {
  it("reports a started background flow", async () => {
    expect(await startFlexibleUpdate(loader())).toBe("started")
  })

  it("distinguishes a user cancel from a failure", async () => {
    expect(
      await startFlexibleUpdate(loader({ startFlexibleUpdate: async () => ({ code: 1 }) }))
    ).toBe("cancelled")
    expect(
      await startFlexibleUpdate(loader({ startFlexibleUpdate: async () => ({ code: 7 }) }))
    ).toBe("failed")
  })

  it("reports unsupported when the native module is absent", async () => {
    expect(await startFlexibleUpdate(missing as never)).toBe("unsupported")
    expect(await performImmediateUpdate(missing as never)).toBe("unsupported")
  })

  it("reports native flow errors as failures, not a missing capability", async () => {
    const fail = async () => {
      throw new Error("Play service failed")
    }
    expect(await startFlexibleUpdate(loader({ startFlexibleUpdate: fail }))).toBe("failed")
    expect(await performImmediateUpdate(loader({ performImmediateUpdate: fail }))).toBe("failed")
  })

  it("completes a downloaded update", async () => {
    expect(await completeFlexibleUpdate(loader())).toBe(true)
    expect(await completeFlexibleUpdate(missing as never)).toBe(false)
  })

  it("opens the store page", async () => {
    expect(await openAppStore(loader())).toBe(true)
    expect(await openAppStore(missing as never)).toBe(false)
  })
})

it("reports download readiness separately from update availability", async () => {
  const out = await getAppUpdateInfo(
    loader({
      getAppUpdateInfo: async () => ({ updateAvailability: 2, installStatus: 11 }),
    })
  )
  expect(out).toMatchObject({ kind: "ok", value: { availability: "available", downloaded: true } })
})

it("preserves Android's available build code", async () => {
  expect(
    await getAppUpdateInfo(
      loader({
        getAppUpdateInfo: async () => ({ updateAvailability: 2, availableVersionCode: "200" }),
      })
    )
  ).toMatchObject({ kind: "ok", value: { availableVersionCode: "200" } })
})

it("listens for download readiness and stops callbacks after cleanup", async () => {
  const handler = jest.fn()
  const remove = jest.fn(async () => {})
  let dispatch: ((state: { installStatus: number }) => void) | undefined
  const addListener = jest.fn(async (_event, callback) => {
    dispatch = callback
    return { remove }
  })
  const stop = await subscribeFlexibleUpdateDownloaded(handler, loader({ addListener }))
  expect(addListener).toHaveBeenCalledWith("onFlexibleUpdateStateChange", expect.any(Function))
  dispatch?.({ installStatus: 2 })
  expect(handler).not.toHaveBeenCalled()
  dispatch?.({ installStatus: 11 })
  expect(handler).toHaveBeenCalledTimes(1)
  stop()
  dispatch?.({ installStatus: 11 })
  await Promise.resolve()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledTimes(1)
})

it("offers an inert listener when the plugin is missing", async () => {
  const stop = await subscribeFlexibleUpdateDownloaded(jest.fn(), missing as never)
  expect(() => stop()).not.toThrow()
})
