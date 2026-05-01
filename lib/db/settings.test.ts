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
