const transportCall = jest.fn()

// Arrow indirection (not a bare reference) so the factory doesn't capture
// `transportCall` before its TDZ ends — see the jest-gotchas skill.
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => transportCall(...args) },
}))

const resolveHomeMock = jest.fn<Promise<string | null>, []>()
jest.mock("@/lib/memory/external/home", () => ({
  resolveHome: () => resolveHomeMock(),
  detectPlatform: () => "linux",
}))

import {
  EMPTY_VENDOR_ROOTS,
  hasAnyVendorRoot,
  resolveVendorRoots,
  vendorRootsFromEnv,
  vendorRootsFromHome,
  __resetVendorRootsCacheForTesting,
  type VendorRoots,
} from "./index"

const DESKTOP_ROOTS: VendorRoots = {
  claudeConfigDir: "/custom/claude",
  codexHome: "/custom/codex",
  opencodeConfigDir: "/xdg/config/opencode",
  opencodeDataDir: "/xdg/data/opencode",
  piAgentDir: "/custom/pi-agent",
  piSessionDir: "/custom/pi-agent/sessions",
}

beforeEach(() => {
  __resetVendorRootsCacheForTesting()
  transportCall.mockReset()
  resolveHomeMock.mockReset()
  transportCall.mockResolvedValue(DESKTOP_ROOTS)
  resolveHomeMock.mockResolvedValue("/home/u")
})

describe("vendorRootsFromHome", () => {
  it("derives unix conventions from a posix home", () => {
    expect(vendorRootsFromHome("/home/u")).toEqual({
      claudeConfigDir: "/home/u/.claude",
      codexHome: "/home/u/.codex",
      opencodeConfigDir: "/home/u/.config/opencode",
      opencodeDataDir: "/home/u/.local/share/opencode",
      opencodePlatformDataDir: "/home/u/.local/share/opencode",
      piAgentDir: "/home/u/.pi/agent",
      piSessionDir: "/home/u/.pi/agent/sessions",
    })
  })

  it("strips a trailing separator from the home dir", () => {
    expect(vendorRootsFromHome("/home/u/").claudeConfigDir).toBe("/home/u/.claude")
  })

  it("uses the backslash separator for a Windows home", () => {
    const roots = vendorRootsFromHome("C:\\Users\\u", "windows")
    expect(roots.claudeConfigDir).toBe("C:\\Users\\u\\.claude")
    expect(roots.codexHome).toBe("C:\\Users\\u\\.codex")
  })

  it("puts both OpenCode trees under %APPDATA% on Windows", () => {
    const roots = vendorRootsFromHome("C:\\Users\\u", "windows", "C:\\Users\\u\\AppData\\Roaming")
    expect(roots.opencodeConfigDir).toBe("C:\\Users\\u\\AppData\\Roaming\\opencode")
    expect(roots.opencodeDataDir).toBe("C:\\Users\\u\\AppData\\Roaming\\opencode")
    expect(roots.opencodePlatformDataDir).toBe("C:\\Users\\u\\AppData\\Roaming\\opencode")
  })

  it("falls back to a conventional AppData path when none is supplied", () => {
    const roots = vendorRootsFromHome("C:\\Users\\u", "windows")
    expect(roots.opencodeConfigDir).toBe("C:\\Users\\u\\AppData\\Roaming\\opencode")
  })

  it("keeps macOS on the XDG-style ~/.config layout OpenCode actually uses", () => {
    const roots = vendorRootsFromHome("/Users/u", "macos")
    expect(roots.opencodeConfigDir).toBe("/Users/u/.config/opencode")
    expect(roots.opencodePlatformDataDir).toBe("/Users/u/Library/Application Support/opencode")
  })

  it("returns blank roots for an empty or missing home", () => {
    expect(vendorRootsFromHome("")).toEqual(EMPTY_VENDOR_ROOTS)
    expect(vendorRootsFromHome(undefined)).toEqual(EMPTY_VENDOR_ROOTS)
  })
})

describe("vendorRootsFromEnv", () => {
  it("honours CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const roots = vendorRootsFromEnv("/home/u", {
      CLAUDE_CONFIG_DIR: "/custom/claude",
      CODEX_HOME: "/custom/codex",
    })
    expect(roots.claudeConfigDir).toBe("/custom/claude")
    expect(roots.codexHome).toBe("/custom/codex")
    // Unset vars still fall back.
    expect(roots.opencodeConfigDir).toBe("/home/u/.config/opencode")
  })

  it("honours the XDG overrides for OpenCode", () => {
    const roots = vendorRootsFromEnv("/home/u", {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
    })
    expect(roots.opencodeConfigDir).toBe("/xdg/config/opencode")
    expect(roots.opencodeDataDir).toBe("/xdg/data/opencode")
  })

  it("ignores blank overrides and trims trailing separators", () => {
    const roots = vendorRootsFromEnv("/home/u", {
      CLAUDE_CONFIG_DIR: "   ",
      CODEX_HOME: "",
      XDG_CONFIG_HOME: "/xdg/config/",
      XDG_DATA_HOME: "\t",
      PI_CODING_AGENT_DIR: "  ",
      PI_CODING_AGENT_SESSION_DIR: "",
    })
    expect(roots.claudeConfigDir).toBe("/home/u/.claude")
    expect(roots.codexHome).toBe("/home/u/.codex")
    expect(roots.opencodeConfigDir).toBe("/xdg/config/opencode")
    expect(roots.opencodeDataDir).toBe("/home/u/.local/share/opencode")
    expect(roots.piAgentDir).toBe("/home/u/.pi/agent")
    expect(roots.piSessionDir).toBe("/home/u/.pi/agent/sessions")
  })

  // Pi's own getAgentDir() is `join(homedir(), ".pi", "agent")` — the config
  // dir is the `agent` subdir, not `~/.pi`, and the session tree hangs off it.
  // These mirror `paths.rs:pi_roots_*`; the two resolvers must not drift.
  it("hangs the Pi session dir off an overridden agent dir", () => {
    const roots = vendorRootsFromEnv("/home/u", { PI_CODING_AGENT_DIR: "/custom/pi-agent" })
    expect(roots.piAgentDir).toBe("/custom/pi-agent")
    expect(roots.piSessionDir).toBe("/custom/pi-agent/sessions")
  })

  it("lets the Pi session override win independently of the agent dir", () => {
    const roots = vendorRootsFromEnv("/home/u", {
      PI_CODING_AGENT_DIR: "/custom/pi-agent",
      PI_CODING_AGENT_SESSION_DIR: "/elsewhere/sessions",
    })
    expect(roots.piAgentDir).toBe("/custom/pi-agent")
    expect(roots.piSessionDir).toBe("/elsewhere/sessions")
  })

  it("keeps the Pi roots home-relative on Windows", () => {
    // Pi has no XDG/%APPDATA% convention — `.pi/agent` is home-relative on
    // every OS, same as Claude and Codex.
    const roots = vendorRootsFromEnv("C:\\Users\\u", { APPDATA: "D:\\Roaming" }, "windows")
    expect(roots.piAgentDir).toBe("C:\\Users\\u\\.pi\\agent")
    expect(roots.piSessionDir).toBe("C:\\Users\\u\\.pi\\agent\\sessions")
  })

  it("prefers %APPDATA% over the assembled path on Windows", () => {
    const roots = vendorRootsFromEnv("C:\\Users\\u", { APPDATA: "D:\\Roaming" }, "windows")
    expect(roots.opencodeConfigDir).toBe("D:\\Roaming\\opencode")
    expect(roots.opencodeDataDir).toBe("D:\\Roaming\\opencode")
  })

  it("lets XDG win over %APPDATA% on Windows", () => {
    const roots = vendorRootsFromEnv(
      "C:\\Users\\u",
      { APPDATA: "D:\\Roaming", XDG_DATA_HOME: "D:\\xdg" },
      "windows"
    )
    expect(roots.opencodeDataDir).toBe("D:\\xdg\\opencode")
    expect(roots.opencodeConfigDir).toBe("D:\\Roaming\\opencode")
  })

  it("resolves env overrides even without a home dir", () => {
    const roots = vendorRootsFromEnv(undefined, { CODEX_HOME: "/only/codex" })
    expect(roots.codexHome).toBe("/only/codex")
    expect(roots.claudeConfigDir).toBe("")
    expect(roots.opencodeDataDir).toBe("")
  })

  it("leaves the OpenCode roots blank on Windows with no home and no %APPDATA%", () => {
    const roots = vendorRootsFromEnv(undefined, {}, "windows")
    expect(roots).toEqual(EMPTY_VENDOR_ROOTS)
  })
})

describe("hasAnyVendorRoot", () => {
  it("is false for the empty roots and true once one is set", () => {
    expect(hasAnyVendorRoot(EMPTY_VENDOR_ROOTS)).toBe(false)
    expect(hasAnyVendorRoot({ ...EMPTY_VENDOR_ROOTS, codexHome: "/c" })).toBe(true)
  })
})

describe("resolveVendorRoots", () => {
  it("prefers the desktop IPC answer", async () => {
    await expect(resolveVendorRoots()).resolves.toEqual(DESKTOP_ROOTS)
    expect(transportCall).toHaveBeenCalledWith("agent_vendor_roots", undefined)
    expect(resolveHomeMock).not.toHaveBeenCalled()
  })

  it("strips trailing separators coming back from IPC", async () => {
    transportCall.mockResolvedValue({ ...DESKTOP_ROOTS, codexHome: "/custom/codex/" })
    await expect(resolveVendorRoots()).resolves.toMatchObject({ codexHome: "/custom/codex" })
  })

  it("falls back to the home-derived roots when the IPC throws", async () => {
    transportCall.mockRejectedValue(new Error("not tauri"))
    await expect(resolveVendorRoots()).resolves.toEqual(vendorRootsFromHome("/home/u"))
  })

  it.each([[null], ["nope"], [{}], [{ claudeConfigDir: 42 }]])(
    "falls back when the IPC returns %p",
    async (payload) => {
      transportCall.mockResolvedValue(payload)
      await expect(resolveVendorRoots()).resolves.toMatchObject({
        claudeConfigDir: "/home/u/.claude",
      })
    }
  )

  it("returns blank roots when neither IPC nor home resolves", async () => {
    transportCall.mockResolvedValue(null)
    resolveHomeMock.mockResolvedValue(null)
    await expect(resolveVendorRoots()).resolves.toEqual(EMPTY_VENDOR_ROOTS)
  })

  it("memoizes a successful resolution", async () => {
    await resolveVendorRoots()
    await resolveVendorRoots()
    expect(transportCall).toHaveBeenCalledTimes(1)
  })

  it("does not cache a failed resolution, so a later call retries", async () => {
    transportCall.mockResolvedValue(null)
    resolveHomeMock.mockResolvedValue(null)
    await expect(resolveVendorRoots()).resolves.toEqual(EMPTY_VENDOR_ROOTS)
    transportCall.mockResolvedValue(DESKTOP_ROOTS)
    await expect(resolveVendorRoots()).resolves.toEqual(DESKTOP_ROOTS)
  })

  it("bypasses the cache whenever deps are injected", async () => {
    const call = jest.fn(async () => DESKTOP_ROOTS)
    await resolveVendorRoots({ call: call as never })
    await resolveVendorRoots({ call: call as never })
    expect(call).toHaveBeenCalledTimes(2)
    expect(transportCall).not.toHaveBeenCalled()
  })

  it("honours an injected home + platform without touching IPC", async () => {
    const roots = await resolveVendorRoots({
      call: (async () => null) as never,
      homeDir: async () => "C:\\Users\\u",
      platform: "windows",
    })
    expect(roots.claudeConfigDir).toBe("C:\\Users\\u\\.claude")
  })
})
