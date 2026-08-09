import {
  __resetKnownConnectorKindsForTesting,
  isKnownConnectorKind,
  listKnownConnectorKinds,
  registerPluginConnectorKind,
  unregisterPluginConnectorKindsByPlugin,
} from "./known-kinds"

beforeEach(() => {
  __resetKnownConnectorKindsForTesting()
})

afterEach(() => {
  __resetKnownConnectorKindsForTesting()
})

describe("built-in kinds", () => {
  it("includes kinds with a real adapter behind them", () => {
    expect(isKnownConnectorKind("telegram")).toBe(true)
    expect(isKnownConnectorKind("discord")).toBe(true)
    expect(isKnownConnectorKind("slack")).toBe(true)
  })

  it("excludes reserved-but-unimplemented kinds", () => {
    // These appear in ALL_PLATFORM_KINDS but have no branch in
    // adapter-registry's buildAdapterFromRow. Counting them as available would
    // silently swallow the exact missing dependency the warning exists for.
    for (const planned of ["email", "kook", "line", "mattermost"]) {
      expect(isKnownConnectorKind(planned)).toBe(false)
    }
  })

  it("rejects an entirely unknown kind", () => {
    expect(isKnownConnectorKind("carrier-pigeon")).toBe(false)
  })
})

describe("plugin-contributed kinds", () => {
  it("become resolvable once registered", () => {
    expect(isKnownConnectorKind("acme-chat")).toBe(false)
    registerPluginConnectorKind("acme.plugin", "acme-chat")
    expect(isKnownConnectorKind("acme-chat")).toBe(true)
  })

  it("stop resolving once the owning plugin is unregistered", () => {
    registerPluginConnectorKind("acme.plugin", "acme-chat")
    expect(unregisterPluginConnectorKindsByPlugin("acme.plugin")).toBe(1)
    expect(isKnownConnectorKind("acme-chat")).toBe(false)
  })

  it("registration is idempotent", () => {
    registerPluginConnectorKind("acme.plugin", "acme-chat")
    registerPluginConnectorKind("acme.plugin", "acme-chat")
    expect(unregisterPluginConnectorKindsByPlugin("acme.plugin")).toBe(1)
  })

  it("unregistering one plugin leaves another plugin's kinds alone", () => {
    registerPluginConnectorKind("a", "kind-a")
    registerPluginConnectorKind("b", "kind-b")
    unregisterPluginConnectorKindsByPlugin("a")
    expect(isKnownConnectorKind("kind-a")).toBe(false)
    expect(isKnownConnectorKind("kind-b")).toBe(true)
  })

  it("unregistering an unknown plugin is a no-op", () => {
    expect(unregisterPluginConnectorKindsByPlugin("ghost")).toBe(0)
  })

  it("never removes a built-in kind", () => {
    registerPluginConnectorKind("a", "telegram")
    unregisterPluginConnectorKindsByPlugin("a")
    expect(isKnownConnectorKind("telegram")).toBe(true)
  })
})

describe("listKnownConnectorKinds", () => {
  it("returns a sorted union of built-in and plugin kinds", () => {
    registerPluginConnectorKind("acme.plugin", "zzz-chat")
    const kinds = listKnownConnectorKinds()
    expect(kinds).toContain("telegram")
    expect(kinds).toContain("zzz-chat")
    expect([...kinds]).toEqual([...kinds].sort())
  })

  it("deduplicates a plugin kind that shadows a built-in", () => {
    registerPluginConnectorKind("acme.plugin", "telegram")
    const kinds = listKnownConnectorKinds()
    expect(kinds.filter((k) => k === "telegram")).toHaveLength(1)
  })
})
