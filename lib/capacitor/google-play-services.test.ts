import { getGooglePlayServicesStatus } from "./google-play-services"

describe("getGooglePlayServicesStatus", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "Capacitor")
    jest.useRealTimers()
  })

  it("reports ready Google Play Services", async () => {
    await expect(
      getGooglePlayServicesStatus(async () => ({
        getStatus: async () => ({ available: true, status: 0 }),
      }))
    ).resolves.toEqual({ available: true, status: 0 })
  })

  it.each([1, 2, 3, 9, 18])("routes unavailable status %s away from GMS", async (status) => {
    await expect(
      getGooglePlayServicesStatus(async () => ({
        getStatus: async () => ({ available: false, status }),
      }))
    ).resolves.toEqual({ available: false, status })
  })

  it("does not trust an inconsistent availability flag", async () => {
    await expect(
      getGooglePlayServicesStatus(async () => ({
        getStatus: async () => ({ available: true, status: 3 }),
      }))
    ).resolves.toEqual({ available: false, status: 3 })
  })

  it("treats a missing bridge as unknown", async () => {
    await expect(getGooglePlayServicesStatus()).resolves.toEqual({
      available: false,
      status: "unknown",
    })
  })

  it("treats a native failure as unknown", async () => {
    await expect(
      getGooglePlayServicesStatus(async () => ({
        getStatus: async () => {
          throw new Error("bridge unavailable")
        },
      }))
    ).resolves.toEqual({ available: false, status: "unknown" })
  })

  it("bounds a stalled native check and releases its deadline", async () => {
    jest.useFakeTimers()
    const result = getGooglePlayServicesStatus(async () => ({
      getStatus: () => new Promise(() => {}),
    }))
    await jest.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toEqual({ available: false, status: "unknown" })
    expect(jest.getTimerCount()).toBe(0)
  })

  it("clears its deadline after a successful check", async () => {
    jest.useFakeTimers()
    await getGooglePlayServicesStatus(async () => ({
      getStatus: async () => ({ available: true, status: 0 }),
    }))
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([undefined, {}, { status: "0" }, { status: -1 }, { status: NaN }])(
    "treats invalid native data %p as unknown",
    async (result) => {
      await expect(
        getGooglePlayServicesStatus(async () => ({ getStatus: async () => result }))
      ).resolves.toEqual({ available: false, status: "unknown" })
    }
  )

  it("loads the registered local plugin without assimilating its then proxy", async () => {
    const then = jest.fn()
    const plugin = new Proxy(
      { getStatus: jest.fn().mockResolvedValue({ available: true, status: 0 }) },
      { get: (target, property) => (property === "then" ? then : Reflect.get(target, property)) }
    )
    Object.assign(globalThis, { Capacitor: { Plugins: { CogniaDeviceServices: plugin } } })

    await expect(getGooglePlayServicesStatus()).resolves.toEqual({ available: true, status: 0 })
    expect(plugin.getStatus).toHaveBeenCalledTimes(1)
    expect(then).not.toHaveBeenCalled()
  })
})
