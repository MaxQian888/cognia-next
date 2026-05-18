// Coverage for the singleton settings module — get/save defaults, partial
// patches, and the alwaysAllow tool list helpers.

import "fake-indexeddb/auto"
import { addAlwaysAllow, getSettings, removeAlwaysAllow, saveSettings } from "./settings"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().settings.clear()
})

describe("getSettings", () => {
  it("returns the canonical defaults when nothing has been written", async () => {
    const s = await getSettings()
    expect(s.id).toBe("singleton")
    expect(s.permissionMode).toBe("default")
    expect(s.alwaysAllowTools).toEqual([])
    expect(s.theme).toBe("system")
    expect(s.fontScale).toBe("md")
    expect(s.searchEnabled).toBe(false)
    expect(s.searchProviders).toBeDefined()
  })

  it("fills appearance defaults when missing", async () => {
    const s = await getSettings()
    expect(s.background).toEqual({
      enabled: false,
      activeId: null,
      scope: "all",
      blurPx: 0,
      opacity: 1,
      position: "cover",
    })
    expect(s.wallpapers).toEqual([])
    expect(s.customCss).toBe("")
    expect(s.customCssEnabled).toBe(false)
    expect(s.importedVscodeThemes).toEqual([])
  })

  it("merges background defaults under a partial saved row", async () => {
    await getDb().settings.put({
      id: "singleton",
      permissionMode: "default",
      alwaysAllowTools: [],
      background: { enabled: true, activeId: "wp-1", scope: "chat" },
    } as unknown as Awaited<ReturnType<typeof getSettings>>)
    const s = await getSettings()
    // Persisted fields win.
    expect(s.background?.enabled).toBe(true)
    expect(s.background?.activeId).toBe("wp-1")
    expect(s.background?.scope).toBe("chat")
    // Missing nested fields filled from defaults.
    expect(s.background?.blurPx).toBe(0)
    expect(s.background?.opacity).toBe(1)
    expect(s.background?.position).toBe("cover")
  })

  it("returns DEFAULT_OCR_SETTINGS for fresh installs", async () => {
    const s = await getSettings()
    expect(s.ocrSettings).toBeDefined()
    expect(s.ocrSettings?.defaultProviderId).toBe("auto")
    expect(s.ocrSettings?.cloudFallbackProviderId).toBe("mistral-ocr")
    expect(s.ocrSettings?.cacheTtlDays).toBe(30)
    expect(s.ocrSettings?.ocrWizardDismissed).toBe(false)
    expect(s.ocrSettings?.platformOverrides).toEqual({})
  })

  it("merges user-supplied OCR overrides under the defaults", async () => {
    await getDb().settings.put({
      id: "singleton",
      permissionMode: "default",
      alwaysAllowTools: [],
      ocrSettings: {
        defaultProviderId: "mistral-ocr",
        platformOverrides: { windows: ["ocrs", "tesseract-wasm"] },
        ocrWizardDismissed: true,
      },
    } as unknown as Awaited<ReturnType<typeof getSettings>>)
    const s = await getSettings()
    // Persisted fields win.
    expect(s.ocrSettings?.defaultProviderId).toBe("mistral-ocr")
    expect(s.ocrSettings?.platformOverrides?.windows).toEqual(["ocrs", "tesseract-wasm"])
    expect(s.ocrSettings?.ocrWizardDismissed).toBe(true)
    // Missing fields filled from defaults.
    expect(s.ocrSettings?.cacheTtlDays).toBe(30)
    expect(s.ocrSettings?.defaultFormat).toBe("markdown")
  })

  it("defaults onboardingDismissedAt to undefined for fresh installs", async () => {
    const s = await getSettings()
    expect(s.onboardingDismissedAt).toBeUndefined()
  })

  it("preserves a saved onboardingDismissedAt across get/save round-trips", async () => {
    const ts = "2026-05-18T12:00:00.000Z"
    await saveSettings({ onboardingDismissedAt: ts })
    const s = await getSettings()
    expect(s.onboardingDismissedAt).toBe(ts)
  })

  it("merges defaults under a partially-populated row (forward compat)", async () => {
    // Write only the bare minimum to simulate an older install that didn't
    // know about searchProviders.
    await getDb().settings.put({
      id: "singleton",
      permissionMode: "default",
      alwaysAllowTools: ["bash"],
    } as unknown as Awaited<ReturnType<typeof getSettings>>)
    const s = await getSettings()
    // Persisted field wins.
    expect(s.alwaysAllowTools).toEqual(["bash"])
    // Missing field is filled from defaults.
    expect(s.theme).toBe("system")
    expect(s.searchProviders).toBeDefined()
    // Newly-introduced nested object is populated from DEFAULT_BUILTIN_TOOLS.
    expect(s.builtinTools).toBeDefined()
    expect(s.builtinTools.fileExtras).toBe(true)
    expect(s.builtinTools.shellAdvanced).toBe(false)
  })
})

describe("saveSettings", () => {
  it("persists the patch and returns the merged row", async () => {
    const out = await saveSettings({ theme: "dark", apiKey: "sk-test" })
    expect(out.theme).toBe("dark")
    expect(out.apiKey).toBe("sk-test")
    const fetched = await getSettings()
    expect(fetched.theme).toBe("dark")
    expect(fetched.apiKey).toBe("sk-test")
  })

  it("preserves prior fields not mentioned in the patch", async () => {
    await saveSettings({ theme: "dark" })
    await saveSettings({ apiKey: "sk-test" })
    const fetched = await getSettings()
    expect(fetched.theme).toBe("dark")
    expect(fetched.apiKey).toBe("sk-test")
  })

  it("serializes concurrent writes so no patch is lost to a read-modify-write race", async () => {
    // Without serialization, two concurrent saveSettings calls both call
    // getSettings() against the persisted DB row, then each `put` overwrites
    // the other. This is the exact race that wiped customThemes when
    // createCustomTheme + setActiveCustomTheme fired together — we lock
    // it down here.
    const [a, b] = await Promise.all([
      saveSettings({ theme: "dark" }),
      saveSettings({ apiKey: "sk-test" }),
    ])
    // Both observed the merged result of the chain (the second to land sees
    // the first's write). At minimum, the final fetch must contain BOTH.
    expect(a.id).toBe("singleton")
    expect(b.id).toBe("singleton")
    const fetched = await getSettings()
    expect(fetched.theme).toBe("dark")
    expect(fetched.apiKey).toBe("sk-test")
  })

  it("serializes a long chain of concurrent patches into the same row", async () => {
    // 8 concurrent writes touching disjoint fields — every patch must
    // survive when the queue drains.
    const results = await Promise.all([
      saveSettings({ theme: "dark" }),
      saveSettings({ apiKey: "sk-1" }),
      saveSettings({ language: "zh-CN" }),
      saveSettings({ defaultModel: "model-x" }),
      saveSettings({ activeCustomThemeId: "ct-7" }),
      saveSettings({ colorTheme: "ocean" }),
      saveSettings({ customThemes: [{ id: "ct-7", name: "Imported" }] }),
      saveSettings({
        importedVscodeThemes: [
          {
            customThemeId: "ct-7",
            sourceName: "Imported",
            sourceVariant: "dark",
            importedAt: 0,
            origin: { kind: "json", fileName: "x.json" },
          },
        ],
      }),
    ])
    expect(results).toHaveLength(8)
    const fetched = await getSettings()
    expect(fetched.theme).toBe("dark")
    expect(fetched.apiKey).toBe("sk-1")
    expect(fetched.language).toBe("zh-CN")
    expect(fetched.defaultModel).toBe("model-x")
    expect(fetched.activeCustomThemeId).toBe("ct-7")
    expect(fetched.colorTheme).toBe("ocean")
    expect(fetched.customThemes).toEqual([{ id: "ct-7", name: "Imported" }])
    expect(fetched.importedVscodeThemes).toHaveLength(1)
    expect(fetched.importedVscodeThemes?.[0].customThemeId).toBe("ct-7")
  })
})

describe("addAlwaysAllow", () => {
  it("adds a tool when missing", async () => {
    await addAlwaysAllow("Bash")
    expect((await getSettings()).alwaysAllowTools).toEqual(["Bash"])
  })

  it("is a no-op when the tool is already present", async () => {
    await addAlwaysAllow("Bash")
    await addAlwaysAllow("Bash")
    expect((await getSettings()).alwaysAllowTools).toEqual(["Bash"])
  })
})

describe("removeAlwaysAllow", () => {
  it("filters the named tool out", async () => {
    await addAlwaysAllow("A")
    await addAlwaysAllow("B")
    await removeAlwaysAllow("A")
    expect((await getSettings()).alwaysAllowTools).toEqual(["B"])
  })

  it("does not throw when the tool isn't present", async () => {
    await expect(removeAlwaysAllow("missing")).resolves.toBeUndefined()
  })
})
