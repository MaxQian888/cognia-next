import {
  createProviderSettingsSnapshot,
  resolveFeatureProvider,
  createFeatureProviderClient,
  createFeatureProviderModel,
  type ProviderSettingsSnapshot,
  type ResolvedProvider,
} from "./provider-consumption"

describe("createProviderSettingsSnapshot", () => {
  it("defaults missing inputs to empty collections", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: undefined,
      providerSettings: undefined,
      customProviders: undefined,
    })
    expect(snap).toEqual({ defaultProvider: undefined, providers: {}, customProviders: [] })
  })

  it("maps rich custom-provider rows and converts gemini → google protocol", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: "openai",
      providerSettings: { openai: { enabled: true, apiKey: "sk" } },
      customProviders: [
        { id: "c1", apiProtocol: "gemini", baseURL: "https://x", apiKey: "k", defaultModel: "m" },
      ],
    })
    expect(snap.defaultProvider).toBe("openai")
    expect(snap.providers.openai.apiKey).toBe("sk")
    expect(snap.customProviders[0]).toMatchObject({
      id: "c1",
      protocol: "google",
      baseURL: "https://x",
      apiKey: "k",
      defaultModel: "m",
    })
  })

  it("keeps an explicit protocol over the apiProtocol fallback", () => {
    const snap = createProviderSettingsSnapshot({
      defaultProvider: undefined,
      providerSettings: undefined,
      customProviders: [{ id: "c1", protocol: "anthropic", apiProtocol: "gemini", baseURL: "u" }],
    })
    expect(snap.customProviders[0].protocol).toBe("anthropic")
  })
})

describe("resolveFeatureProvider — explicit provider", () => {
  const snap: ProviderSettingsSnapshot = {
    defaultProvider: "openai",
    providers: {
      openai: { enabled: true, apiKey: "sk-openai", defaultModel: "gpt-4o-mini" },
      disabled: { enabled: false, apiKey: "x" },
      nokey: { enabled: true },
    },
    customProviders: [
      {
        id: "proxy",
        name: "Proxy",
        protocol: "openai",
        baseURL: "https://proxy.test",
        apiKey: "pk",
        defaultModel: "m",
      },
    ],
  }

  it("resolves a built-in provider with its protocol derived from the id", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "openai",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("resolved")
    const resolved = r as ResolvedProvider
    expect(resolved.protocol).toBe("openai")
    expect(resolved.apiKey).toBe("sk-openai")
    expect(resolved.model).toBe("gpt-4o-mini")
    expect(resolved.isCustomProvider).toBe(false)
  })

  it("resolves a custom provider and marks isCustomProvider", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "proxy",
        fallbackMode: "none",
      },
      snap
    )
    const resolved = r as ResolvedProvider
    expect(resolved.kind).toBe("resolved")
    expect(resolved.isCustomProvider).toBe(true)
    expect(resolved.baseURL).toBe("https://proxy.test")
  })

  it("reports an unconfigured provider", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "ghost",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("open_provider_settings")
  })

  it("reports a disabled provider", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "disabled",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("enable_provider")
  })

  it("reports a provider missing both key and base url", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "nokey",
        fallbackMode: "none",
      },
      snap
    )
    expect(r.kind).toBe("unresolved")
    if (r.kind !== "resolved") expect(r.nextAction).toBe("add_api_key")
  })
})

describe("resolveFeatureProvider — local provider base URL defaults", () => {
  it("supplies the OpenAI-compatible /v1 default for a keyless built-in local provider", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: { ollama: { enabled: true, defaultModel: "llama3.2" } },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "ollama",
        fallbackMode: "none",
      },
      snap
    )
    const resolved = r as ResolvedProvider
    expect(resolved.kind).toBe("resolved")
    expect(resolved.protocol).toBe("openai")
    expect(resolved.baseURL).toBe("http://localhost:11434/v1")
    expect(resolved.apiKey).toBeUndefined()
  })

  it("does not override an explicit local base URL", () => {
    const snap: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {
        lmstudio: { enabled: true, baseURL: "http://10.0.0.2:1234/v1", defaultModel: "m" },
      },
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "lmstudio",
        fallbackMode: "none",
      },
      snap
    )
    expect((r as ResolvedProvider).baseURL).toBe("http://10.0.0.2:1234/v1")
  })
})

describe("resolveFeatureProvider — selection + fallback modes", () => {
  const snap: ProviderSettingsSnapshot = {
    defaultProvider: "google",
    providers: {
      google: { enabled: true, apiKey: "gk" },
      openai: { enabled: true, apiKey: "ok" },
      broken: { enabled: true },
    },
    customProviders: [],
  }

  it("'any' mode tries the default provider first", () => {
    const r = resolveFeatureProvider(
      { featureId: "f", routeProfile: "general-text", selectionMode: "any", fallbackMode: "none" },
      snap
    )
    expect((r as ResolvedProvider).providerId).toBe("google")
  })

  it("'supported-providers' walks the supplied list", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "supported-providers",
        supportedProviders: ["broken", "openai"],
        fallbackMode: "none",
      },
      snap
    )
    expect((r as ResolvedProvider).providerId).toBe("openai")
  })

  it("ordered fallback appends the configured fallback chain", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "broken",
        fallbackMode: "ordered",
        fallbackProviderOrder: ["openai"],
      },
      snap
    )
    expect((r as ResolvedProvider).providerId).toBe("openai")
  })

  it("first-eligible fallback scans all configured providers", () => {
    const r = resolveFeatureProvider(
      {
        featureId: "f",
        routeProfile: "general-text",
        selectionMode: "explicit-provider",
        providerId: "broken",
        fallbackMode: "first-eligible",
      },
      snap
    )
    expect((r as ResolvedProvider).kind).toBe("resolved")
  })

  it("returns the last failure reason when no candidate resolves", () => {
    const empty: ProviderSettingsSnapshot = {
      defaultProvider: undefined,
      providers: {},
      customProviders: [],
    }
    const r = resolveFeatureProvider(
      { featureId: "f", routeProfile: "general-text", selectionMode: "any", fallbackMode: "none" },
      empty
    )
    expect(r.kind).toBe("unresolved")
  })
})

describe("createFeatureProviderClient / createFeatureProviderModel", () => {
  const base = {
    providerId: "p",
    apiKey: "k",
    baseURL: undefined,
    isCustomProvider: false,
    useProxy: false,
  }

  it("builds a client for each protocol family", () => {
    for (const protocol of ["openai", "anthropic", "google", "mistral", "cohere"] as const) {
      const client = createFeatureProviderClient({ ...base, protocol })
      expect(client).toBeDefined()
    }
  })

  it("builds a model handle from a resolved provider, backfilling a default model", () => {
    const resolved: ResolvedProvider = {
      kind: "resolved",
      providerId: "openai",
      protocol: "openai",
      apiKey: "k",
      baseURL: undefined,
      model: undefined,
      isCustomProvider: false,
      useProxy: false,
    }
    const model = createFeatureProviderModel(resolved)
    expect(model).toBeDefined()
  })

  it("builds an anthropic model handle for an explicit model id", () => {
    const resolved: ResolvedProvider = {
      kind: "resolved",
      providerId: "anthropic",
      protocol: "anthropic",
      apiKey: "k",
      baseURL: undefined,
      model: "claude-sonnet-4-6",
      isCustomProvider: false,
      useProxy: false,
    }
    expect(createFeatureProviderModel(resolved)).toBeDefined()
  })
})
