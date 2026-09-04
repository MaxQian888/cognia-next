/** @jest-environment jsdom */
import {
  completeFlexibleUpdate,
  getAppUpdateInfo,
  openAppStore,
  performImmediateUpdate,
  startFlexibleUpdate,
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
      await startFlexibleUpdate(loader({ startFlexibleUpdate: async () => ({ code: -1 }) }))
    ).toBe("cancelled")
    expect(
      await startFlexibleUpdate(loader({ startFlexibleUpdate: async () => ({ code: 7 }) }))
    ).toBe("failed")
  })

  it("reports unsupported when the native module is absent", async () => {
    expect(await startFlexibleUpdate(missing as never)).toBe("unsupported")
    expect(await performImmediateUpdate(missing as never)).toBe("unsupported")
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
