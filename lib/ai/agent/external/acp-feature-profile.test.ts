import { resolveAcpFeatureProfile } from "./acp-feature-profile"

describe("resolveAcpFeatureProfile", () => {
  const desktopHost = {
    kind: "desktop" as const,
    fs: { read: true, write: true },
    terminal: true,
    terminalAuth: true,
    elicitation: { form: true, url: true, durableInteraction: true },
    preview: {
      compaction: true,
      providers: true,
      dynamicMcp: true,
      nes: true,
      identifiedPlans: true,
      previewToolNames: true,
      sessionFork: true,
    },
  }

  it("enables stable host-backed capabilities by default", () => {
    const profile = resolveAcpFeatureProfile({ role: "client", host: desktopHost })

    expect(profile.clientCapabilities).toMatchObject({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
      elicitation: { form: {}, url: {} },
      session: { configOptions: { boolean: {} } },
    })
  })

  it.each([false, null])("treats explicit elicitation %s as a kill switch", (enabled) => {
    const profile = resolveAcpFeatureProfile({
      role: "client",
      host: desktopHost,
      elicitationEnabled: enabled,
    })

    expect(profile.clientCapabilities.elicitation).toBeUndefined()
  })

  it("requires a durable controller before headless advertises elicitation", () => {
    const profile = resolveAcpFeatureProfile({
      role: "client",
      host: {
        ...desktopHost,
        kind: "headless",
        terminal: false,
        terminalAuth: false,
        elicitation: { form: true, url: true, durableInteraction: false },
      },
      elicitationEnabled: true,
    })

    expect(profile.clientCapabilities.terminal).toBeUndefined()
    expect(profile.clientCapabilities.auth).toBeUndefined()
    expect(profile.clientCapabilities.elicitation).toBeUndefined()
  })

  it("advertises each preview capability only when enabled and host-backed", () => {
    const profile = resolveAcpFeatureProfile({
      role: "client",
      host: {
        ...desktopHost,
        preview: { ...desktopHost.preview, providers: false },
      },
      preview: { compaction: true, providers: true, nes: true },
    })

    expect(profile.preview.compaction.advertised).toBe(true)
    expect(profile.preview.nes.advertised).toBe(true)
    expect(profile.preview.providers.advertised).toBe(false)
    expect(profile.clientCapabilities.session?.compaction).toEqual({})
    expect(profile.clientCapabilities.nes).toEqual({})
    expect(profile.clientCapabilities.plan).toBeUndefined()
  })

  it("never advertises ACP v2 from the v1 feature profile", () => {
    const profile = resolveAcpFeatureProfile({ role: "agent", host: desktopHost })
    expect(profile.protocol).toEqual({ wireVersion: 1, schemaVersion: "1.21.0" })
    expect(profile.advertisedVersions).toEqual([1])
  })
})
