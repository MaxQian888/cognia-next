/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/app-version", () => ({ APP_VERSION: "1.2.3" }))

const isTauriMock = jest.fn<boolean, []>(() => false)
const isCapacitorMock = jest.fn<boolean, []>(() => false)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  isCapacitor: () => isCapacitorMock(),
}))

const getTauriVersionMock = jest.fn(async () => "2.9.0")
const getNameMock = jest.fn(async () => "Cognia (desktop)")
jest.mock(
  "@tauri-apps/api/app",
  () => ({
    getTauriVersion: () => getTauriVersionMock(),
    getName: () => getNameMock(),
  }),
  { virtual: true }
)

import {
  APP_NAME,
  COPYRIGHT_HOLDER,
  COPYRIGHT_START_YEAR,
  LICENSE_NAME,
  getAppName,
  getBuildInfo,
  getNativeBuildNumber,
  getReleaseChannel,
  getRuntimeVersions,
  parseEngine,
} from "./app-metadata"

beforeEach(() => {
  isTauriMock.mockReturnValue(false)
  isCapacitorMock.mockReturnValue(false)
  delete process.env.NEXT_PUBLIC_GIT_COMMIT
  delete process.env.NEXT_PUBLIC_BUILD_TIME
})

describe("constants", () => {
  it("exposes stable identity facts", () => {
    expect(APP_NAME).toBe("Cognia")
    expect(COPYRIGHT_HOLDER).toBe("AstroAir")
    expect(COPYRIGHT_START_YEAR).toBe(2025)
    expect(LICENSE_NAME).toBeNull()
  })
})

describe("getReleaseChannel", () => {
  it.each([
    ["1.2.3", "stable"],
    ["1.2.3-rc.1", "rc"],
    ["1.2.3-beta.2", "beta"],
    ["1.2.3-alpha", "alpha"],
    ["0.0.0", "dev"],
  ])("maps %s → %s", (version, expected) => {
    expect(getReleaseChannel(version)).toBe(expected)
  })

  it("defaults to APP_VERSION when no arg", () => {
    expect(getReleaseChannel()).toBe("stable")
  })
})

describe("parseEngine", () => {
  it("detects Chromium", () => {
    expect(parseEngine("Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36")).toBe("Chromium 130.0.0.0")
  })
  it("detects WebKit when no Chrome token", () => {
    expect(parseEngine("Mozilla/5.0 AppleWebKit/605.1.15 (KHTML)")).toBe("WebKit 605.1.15")
  })
  it("returns null for unknown / empty UA", () => {
    expect(parseEngine("Lynx")).toBeNull()
    expect(parseEngine(undefined)).toBeNull()
  })
})

describe("getBuildInfo", () => {
  it("reads injected envs", () => {
    process.env.NEXT_PUBLIC_GIT_COMMIT = "abc1234"
    process.env.NEXT_PUBLIC_BUILD_TIME = "2026-05-30T00:00:00.000Z"
    expect(getBuildInfo()).toEqual({ commit: "abc1234", buildTime: "2026-05-30T00:00:00.000Z" })
  })
  it("falls back to empty strings", () => {
    expect(getBuildInfo()).toEqual({ commit: "", buildTime: "" })
  })
})

describe("getRuntimeVersions", () => {
  it("returns react version and null tauri off-desktop", async () => {
    const v = await getRuntimeVersions()
    expect(v.tauri).toBeNull()
    expect(v.react).toMatch(/^\d+\./)
  })
  it("reads the tauri version on desktop", async () => {
    isTauriMock.mockReturnValue(true)
    const v = await getRuntimeVersions()
    expect(v.tauri).toBe("2.9.0")
  })
  it("tolerates a failing tauri import", async () => {
    isTauriMock.mockReturnValue(true)
    getTauriVersionMock.mockRejectedValueOnce(new Error("nope"))
    const v = await getRuntimeVersions()
    expect(v.tauri).toBeNull()
  })
})

describe("getAppName", () => {
  it("returns the static name off-desktop", async () => {
    expect(await getAppName()).toBe("Cognia")
  })
  it("returns the tauri runtime name on desktop", async () => {
    isTauriMock.mockReturnValue(true)
    expect(await getAppName()).toBe("Cognia (desktop)")
  })
  it("falls back to APP_NAME when the tauri call throws", async () => {
    isTauriMock.mockReturnValue(true)
    getNameMock.mockRejectedValueOnce(new Error("nope"))
    expect(await getAppName()).toBe("Cognia")
  })
})

describe("getNativeBuildNumber", () => {
  it("uses an injected loader", async () => {
    expect(await getNativeBuildNumber(async () => "4242")).toBe("4242")
  })
  it("returns null off-Capacitor without a loader", async () => {
    expect(await getNativeBuildNumber()).toBeNull()
  })
})
