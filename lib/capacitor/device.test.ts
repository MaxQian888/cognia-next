import { getDeviceInfo, type DeviceLoader } from "./device"

function makeLoader(over: Partial<Record<string, unknown>> = {}): DeviceLoader {
  return async () =>
    ({
      getInfo: async () => ({
        model: "Pixel 8",
        platform: "android",
        operatingSystem: "android",
        osVersion: "14",
        manufacturer: "Google",
        isVirtual: false,
        webViewVersion: "120.0",
        memUsed: 256_000_000,
        realDiskFree: 10_000_000_000,
        realDiskTotal: 64_000_000_000,
      }),
      getBatteryInfo: async () => ({ batteryLevel: 0.82, isCharging: true }),
      getLanguageCode: async () => ({ value: "en" }),
      ...over,
    }) as unknown as Awaited<ReturnType<DeviceLoader>>
}

describe("getDeviceInfo", () => {
  it("merges hardware, battery and language fields", async () => {
    const out = await getDeviceInfo(makeLoader())
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.value.model).toBe("Pixel 8")
    expect(out.value.manufacturer).toBe("Google")
    expect(out.value.osVersion).toBe("14")
    expect(out.value.memUsed).toBe(256_000_000)
    expect(out.value.realDiskTotal).toBe(64_000_000_000)
    expect(out.value.batteryLevel).toBe(0.82)
    expect(out.value.isCharging).toBe(true)
    expect(out.value.languageCode).toBe("en")
  })

  it("keeps core fields when the battery sub-call throws", async () => {
    const out = await getDeviceInfo(
      makeLoader({
        getBatteryInfo: async () => {
          throw new Error("no battery api")
        },
      })
    )
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.value.model).toBe("Pixel 8")
    expect(out.value.batteryLevel).toBeUndefined()
    expect(out.value.languageCode).toBe("en")
  })

  it("keeps core fields when the language sub-call throws", async () => {
    const out = await getDeviceInfo(
      makeLoader({
        getLanguageCode: async () => {
          throw new Error("no language api")
        },
      })
    )
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") return
    expect(out.value.languageCode).toBeUndefined()
    expect(out.value.batteryLevel).toBe(0.82)
  })

  it("returns unsupported when the plugin cannot load", async () => {
    const out = await getDeviceInfo(async () => {
      throw new Error("not on this platform")
    })
    expect(out.kind).toBe("unsupported")
  })

  it("returns error when getInfo throws", async () => {
    const out = await getDeviceInfo(
      makeLoader({
        getInfo: async () => {
          throw new Error("boom")
        },
      })
    )
    expect(out.kind).toBe("error")
    if (out.kind !== "error") return
    expect(out.message).toMatch(/boom/)
  })
})
