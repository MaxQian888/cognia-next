import {
  OPEN_VSX_TARGET_PLATFORMS,
  OpenVsxPlatformError,
  mapHostToTargetPlatform,
  resolveTargetPlatform,
  selectPlatformBuild,
  type PlatformCandidate,
} from "./openvsx-platform"

jest.mock("@/lib/tauri/os", () => ({ getOsInfo: jest.fn() }))
import { getOsInfo } from "@/lib/tauri/os"
const getOsInfoMock = getOsInfo as jest.Mock

function candidate(targetPlatform: string, downloadable?: boolean): PlatformCandidate {
  return { targetPlatform, ...(downloadable === undefined ? {} : { downloadable }) }
}

beforeEach(() => {
  getOsInfoMock.mockReset()
})

describe("selectPlatformBuild", () => {
  it("prefers_exact_platform_over_universal", () => {
    const exact = candidate("darwin-arm64")
    const universal = candidate("universal")
    // Order reversed to prove it's matching, not taking the first entry.
    expect(selectPlatformBuild([universal, exact], "darwin-arm64")).toBe(exact)
  })

  it("falls_back_to_universal", () => {
    const universal = candidate("universal")
    const other = candidate("linux-x64")
    expect(selectPlatformBuild([other, universal], "darwin-arm64")).toBe(universal)
  })

  it("refuses_mismatched_platform_rather_than_guessing", () => {
    // A win32-arm64 host with only a win32-x64 build. Installing it "works"
    // until the bundled native LSP binary spawns under emulation and dies —
    // long after install, looking like a cognia bug. So: refuse.
    const error = (() => {
      try {
        selectPlatformBuild([candidate("win32-x64")], "win32-arm64")
        return null
      } catch (e) {
        return e
      }
    })()

    expect(error).toBeInstanceOf(OpenVsxPlatformError)
    expect((error as OpenVsxPlatformError).reason).toBe("no_matching_build")
    expect((error as OpenVsxPlatformError).message).toMatch(/win32-arm64/)
    expect((error as OpenVsxPlatformError).message).toMatch(/win32-x64/)
  })

  it("non_downloadable_version_is_rejected", () => {
    const error = (() => {
      try {
        selectPlatformBuild([candidate("darwin-arm64", false)], "darwin-arm64")
        return null
      } catch (e) {
        return e
      }
    })()

    expect(error).toBeInstanceOf(OpenVsxPlatformError)
    expect((error as OpenVsxPlatformError).reason).toBe("not_downloadable")
    expect((error as OpenVsxPlatformError).message).toMatch(/not downloadable/)
  })

  it("never returns a non-downloadable exact build, even alongside others", () => {
    const universal = candidate("universal", true)
    const picked = selectPlatformBuild(
      [candidate("darwin-arm64", false), universal],
      "darwin-arm64"
    )
    // Falls back to universal — which runs everywhere, so it is not a guess.
    expect(picked).toBe(universal)
  })

  it("treats an absent downloadable flag as downloadable (search entries lack it)", () => {
    const exact = candidate("linux-x64")
    expect(selectPlatformBuild([exact], "linux-x64")).toBe(exact)
  })

  it("treats an absent targetPlatform as universal", () => {
    const entry: PlatformCandidate = {}
    expect(selectPlatformBuild([entry], "darwin-x64")).toBe(entry)
  })

  it("reports an empty candidate list without guessing", () => {
    expect(() => selectPlatformBuild([], "darwin-arm64")).toThrow(OpenVsxPlatformError)
  })

  it("names an untargeted, non-downloadable build as universal when reporting", () => {
    const error = (() => {
      try {
        selectPlatformBuild([{ downloadable: false }], "darwin-arm64")
        return null
      } catch (e) {
        return e
      }
    })()
    expect((error as OpenVsxPlatformError).reason).toBe("no_matching_build")
    expect((error as OpenVsxPlatformError).message).toMatch(/universal/)
  })
})

describe("mapHostToTargetPlatform", () => {
  it.each([
    ["windows", "x86_64", "win32-x64"],
    ["windows", "aarch64", "win32-arm64"],
    ["windows", "x86", "win32-ia32"],
    ["macos", "x86_64", "darwin-x64"],
    ["macos", "aarch64", "darwin-arm64"],
    ["linux", "x86_64", "linux-x64"],
    ["linux", "aarch64", "linux-arm64"],
    ["linux", "arm", "linux-armhf"],
  ])("maps %s/%s to %s", (platform, arch, expected) => {
    expect(mapHostToTargetPlatform(platform, arch)).toBe(expected)
    expect(OPEN_VSX_TARGET_PLATFORMS).toContain(expected)
  })

  it.each([
    ["ios", "aarch64"],
    ["android", "aarch64"],
    ["freebsd", "x86_64"],
    ["linux", "riscv64"],
    ["macos", "x86"], // no 32-bit macOS target exists
    ["windows", "arm"], // armhf is Linux-only
  ])("returns null for the unsupported host %s/%s", (platform, arch) => {
    expect(mapHostToTargetPlatform(platform, arch)).toBeNull()
  })

  it("maps an Alpine host to linux-* — musl is undetectable via plugin-os", () => {
    // Documented limitation: `platform()`/`arch()` cannot distinguish musl from
    // glibc, so alpine-x64 is never selected and the caller falls back to
    // universal. Pinned so the behaviour is a decision, not a surprise.
    expect(mapHostToTargetPlatform("linux", "x86_64")).toBe("linux-x64")
    expect(mapHostToTargetPlatform("linux", "x86_64")).not.toBe("alpine-x64")
  })
})

describe("resolveTargetPlatform", () => {
  it("resolves the host platform from the OS wrapper", async () => {
    getOsInfoMock.mockResolvedValue({
      platform: "macos",
      arch: "aarch64",
      osType: "macos",
      family: "unix",
      version: "15.0",
      hostname: null,
      locale: null,
    })
    await expect(resolveTargetPlatform()).resolves.toBe("darwin-arm64")
  })

  it("fails with a named error outside Tauri", async () => {
    // getOsInfo returns null in the browser; installing is desktop-only.
    getOsInfoMock.mockResolvedValue(null)
    const error = await resolveTargetPlatform().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpenVsxPlatformError)
    expect((error as OpenVsxPlatformError).reason).toBe("unsupported_host")
    expect((error as OpenVsxPlatformError).message).toMatch(/desktop app/)
  })

  it("fails with a named error on an OS Open VSX has no target for", async () => {
    getOsInfoMock.mockResolvedValue({
      platform: "android",
      arch: "aarch64",
      osType: "android",
      family: "unix",
      version: "14",
      hostname: null,
      locale: null,
    })
    const error = await resolveTargetPlatform().catch((e: unknown) => e)
    expect((error as OpenVsxPlatformError).reason).toBe("unsupported_host")
    expect((error as OpenVsxPlatformError).message).toMatch(/android\/aarch64/)
  })
})
