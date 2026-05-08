/**
 * @jest-environment jsdom
 */
import { getCurrentPosition } from "./geolocation"

function makeGeo(overrides: Record<string, unknown> = {}) {
  return {
    getCurrentPosition: jest.fn().mockResolvedValue({
      coords: { latitude: 39.9, longitude: 116.4, accuracy: 10 },
      timestamp: 12345,
    }),
    requestPermissions: jest.fn().mockResolvedValue({ location: "granted" }),
    checkPermissions: jest.fn().mockResolvedValue({ location: "granted" }),
    ...overrides,
  } as {
    getCurrentPosition: jest.Mock
    requestPermissions: jest.Mock
    checkPermissions: jest.Mock
  }
}

describe("getCurrentPosition", () => {
  it("returns coords + timestamp on success", async () => {
    const geo = makeGeo()
    const out = await getCurrentPosition({ loader: async () => geo })
    expect(out).toEqual({
      kind: "ok",
      value: {
        latitude: 39.9,
        longitude: 116.4,
        accuracy: 10,
        timestamp: 12345,
        altitude: null,
        speed: null,
        heading: null,
      },
    })
  })

  it("requests permission when not granted", async () => {
    const geo = makeGeo({
      checkPermissions: jest.fn().mockResolvedValue({ location: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ location: "granted" }),
    })
    const out = await getCurrentPosition({ loader: async () => geo })
    expect(geo.requestPermissions).toHaveBeenCalled()
    expect((out as { kind: string }).kind).toBe("ok")
  })

  it("returns permission_denied when denied", async () => {
    const geo = makeGeo({
      checkPermissions: jest.fn().mockResolvedValue({ location: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ location: "denied" }),
    })
    const out = await getCurrentPosition({ loader: async () => geo })
    expect(out).toEqual({ kind: "permission_denied" })
  })

  it("returns unsupported when plugin missing", async () => {
    const out = await getCurrentPosition({
      loader: async () => {
        throw new Error("nope")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when getCurrentPosition throws", async () => {
    const geo = makeGeo({
      getCurrentPosition: jest.fn().mockRejectedValue(new Error("timeout")),
    })
    const out = await getCurrentPosition({ loader: async () => geo })
    expect(out).toEqual({ kind: "error", message: "timeout" })
  })
})
