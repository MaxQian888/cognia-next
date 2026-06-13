import { deriveContextKeys, detectOs, type ContextKeyInputs } from "./derive-context-keys"

const base: ContextKeyInputs = {
  isTauri: true,
  os: "windows",
  chatActive: true,
  chatStreaming: false,
  chatHasMessages: true,
  projectActive: false,
  guildKind: "dm",
  allPluginIds: [],
  enabledPluginIds: [],
}

describe("deriveContextKeys", () => {
  it("emits exclusive platform booleans (tauri vs web)", () => {
    expect(deriveContextKeys({ ...base, isTauri: true })).toMatchObject({
      "platform.tauri": true,
      "platform.web": false,
    })
    expect(deriveContextKeys({ ...base, isTauri: false })).toMatchObject({
      "platform.tauri": false,
      "platform.web": true,
    })
  })

  it("emits exactly one true OS key", () => {
    const keys = deriveContextKeys({ ...base, os: "macos" })
    expect(keys["platform.macos"]).toBe(true)
    expect(keys["platform.windows"]).toBe(false)
    expect(keys["platform.linux"]).toBe(false)
  })

  it("projects chat + project state", () => {
    const keys = deriveContextKeys({
      ...base,
      chatActive: true,
      chatStreaming: true,
      chatHasMessages: false,
      projectActive: true,
    })
    expect(keys).toMatchObject({
      "chat.active": true,
      "chat.streaming": true,
      "chat.hasMessages": false,
      "project.active": true,
    })
  })

  it("emits full exclusive guild set so a flip clears the previous value", () => {
    expect(deriveContextKeys({ ...base, guildKind: "team" })).toMatchObject({
      "view.dm": false,
      "view.team": true,
      "view.canvas": false,
      "agent.teamActive": true,
    })
    expect(deriveContextKeys({ ...base, guildKind: "canvas" })).toMatchObject({
      "view.canvas": true,
      "agent.teamActive": false,
    })
  })

  it("emits a boolean per known plugin id reflecting enabled status", () => {
    const keys = deriveContextKeys({
      ...base,
      allPluginIds: ["a", "b", "c"],
      enabledPluginIds: ["a", "c"],
    })
    expect(keys["plugin.a.enabled"]).toBe(true)
    expect(keys["plugin.b.enabled"]).toBe(false)
    expect(keys["plugin.c.enabled"]).toBe(true)
  })
})

describe("detectOs", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original)
  })

  function setPlatform(platform: string | undefined): void {
    Object.defineProperty(globalThis, "navigator", {
      value: platform === undefined ? {} : { platform },
      configurable: true,
    })
  }

  it.each([
    ["Win32", "windows"],
    ["MacIntel", "macos"],
    ["Linux x86_64", "linux"],
    ["FreeBSD", "unknown"],
  ])("maps navigator.platform %s → %s", (platform, expected) => {
    setPlatform(platform)
    expect(detectOs()).toBe(expected)
  })

  it("returns unknown when navigator.platform is absent", () => {
    setPlatform(undefined)
    expect(detectOs()).toBe("unknown")
  })
})
