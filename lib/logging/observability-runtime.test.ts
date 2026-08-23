import {
  INSTALLATION_ID_STORAGE_KEY,
  POSTHOG_PRODUCT_DISTINCT_ID_STORAGE_KEY,
  createObservabilityRuntimeScope,
  resolvePostHogProductDistinctId,
  resolveObservabilityRuntime,
} from "./observability-runtime"

describe("observability runtime identity", () => {
  it("persists one pseudonymous installation id without using account content", () => {
    const storage = new Map<string, string>()
    const storageApi = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    }
    const first = createObservabilityRuntimeScope({
      runtime: "browser",
      processId: "session-1",
      storage: storageApi,
      randomId: () => "install-generated",
      environment: {
        tenantId: "tenant-public",
        appVersion: "1.2.3",
        buildId: "build-123",
      },
    })
    const second = createObservabilityRuntimeScope({
      runtime: "browser",
      processId: "session-2",
      storage: storageApi,
      randomId: () => "should-not-be-used",
      environment: {
        tenantId: "tenant-public",
        appVersion: "1.2.3",
        buildId: "build-123",
      },
    })

    expect(first.installationId).toBe("install-generated")
    expect(second.installationId).toBe("install-generated")
    expect(storage.get(INSTALLATION_ID_STORAGE_KEY)).toBe("install-generated")
    expect(first).toMatchObject({ tenantId: "tenant-public", buildId: "build-123" })
  })

  it("reports Capacitor iOS and Android separately from browser and Tauri", () => {
    expect(resolveObservabilityRuntime({ isTauri: true, userAgent: "" })).toBe("tauri")
    expect(
      resolveObservabilityRuntime({
        isTauri: false,
        platformHint: "mobile",
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
      })
    ).toBe("capacitor-android")
    expect(
      resolveObservabilityRuntime({
        isTauri: false,
        platformHint: "mobile",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      })
    ).toBe("capacitor-ios")
    expect(resolveObservabilityRuntime({ isTauri: false, userAgent: "Chrome" })).toBe("browser")
  })

  it("persists a product-only PostHog id that is distinct from the AI observability id", () => {
    const storage = new Map<string, string>([[INSTALLATION_ID_STORAGE_KEY, "ai-install-1"]])
    const storageApi = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    }

    const first = resolvePostHogProductDistinctId(storageApi, () => "product-install-1")
    const second = resolvePostHogProductDistinctId(storageApi, () => "unused")

    expect(first).toBe("product-install-1")
    expect(second).toBe("product-install-1")
    expect(first).not.toBe(storage.get(INSTALLATION_ID_STORAGE_KEY))
    expect(storage.get(POSTHOG_PRODUCT_DISTINCT_ID_STORAGE_KEY)).toBe("product-install-1")
  })

  it("rotates an unsafe or AI-shared persisted Product Analytics id", () => {
    const storage = new Map<string, string>([
      [INSTALLATION_ID_STORAGE_KEY, "ai-install-1"],
      [POSTHOG_PRODUCT_DISTINCT_ID_STORAGE_KEY, "ai-install-1"],
    ])
    const storageApi = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    }

    expect(resolvePostHogProductDistinctId(storageApi, () => "product-install-2")).toBe(
      "product-install-2"
    )
    storage.set(POSTHOG_PRODUCT_DISTINCT_ID_STORAGE_KEY, "jane.doe@example.com")
    expect(resolvePostHogProductDistinctId(storageApi, () => "product-install-3")).toBe(
      "product-install-3"
    )
  })
})
