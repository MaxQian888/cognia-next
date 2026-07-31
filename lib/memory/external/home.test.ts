/**
 * @jest-environment jsdom
 */
import { defaultHomeDir, detectPlatform, encodeClaudeProject, resolveHome } from "./home"

describe("resolveHome", () => {
  it("strips a trailing separator from the resolved home", async () => {
    const home = await resolveHome({ homeDir: async () => "/Users/x/" })
    expect(home).toBe("/Users/x")
  })

  it("returns null when the resolver yields null", async () => {
    expect(await resolveHome({ homeDir: async () => null })).toBeNull()
  })

  it("falls back to the Tauri homeDir resolver by default", async () => {
    // No `@tauri-apps/api/path` in jsdom → defaultHomeDir swallows the import
    // error and returns null, which resolveHome passes through.
    expect(await resolveHome()).toBeNull()
  })
})

describe("defaultHomeDir", () => {
  it("returns null when the Tauri path module is unavailable", async () => {
    expect(await defaultHomeDir()).toBeNull()
  })
})

describe("detectPlatform", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X)", "macos"],
    ["Mozilla/5.0 (Windows NT 10.0)", "windows"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "linux"],
  ])("maps %s → %s", (ua, expected) => {
    expect(detectPlatform(ua)).toBe(expected)
  })

  it("reads navigator.userAgent when no string is passed", () => {
    // jsdom provides a navigator; just assert it returns a known platform.
    expect(["macos", "windows", "linux"]).toContain(detectPlatform())
  })
})

describe("encodeClaudeProject", () => {
  it("replaces slashes and dots with dashes (matching Claude Code)", () => {
    expect(encodeClaudeProject("/Users/bytedance/Project/cognia-next")).toBe(
      "-Users-bytedance-Project-cognia-next"
    )
  })

  it("encodes dotted segments", () => {
    expect(encodeClaudeProject("/home/x/.config/app")).toBe("-home-x--config-app")
  })

  it("ignores a trailing separator", () => {
    expect(encodeClaudeProject("/a/b/")).toBe("-a-b")
  })
})
