import { createMessageResolver, loadMessageResolver } from "./i18n"

describe("headless message resolution", () => {
  const resolve = createMessageResolver({
    settings: {
      backup: {
        done: "Backup finished",
        failed: "Backup failed: {reason}",
        count: "{count} files",
      },
    },
    flat: "top-level",
  })

  it("resolves dot-path keys", () => {
    expect(resolve("settings.backup.done")).toBe("Backup finished")
    expect(resolve("flat")).toBe("top-level")
  })

  it("interpolates {param} placeholders", () => {
    expect(resolve("settings.backup.failed", { reason: "disk full" })).toBe(
      "Backup failed: disk full"
    )
    expect(resolve("settings.backup.count", { count: 3 })).toBe("3 files")
  })

  it("leaves unknown placeholders and keys intact", () => {
    expect(resolve("settings.backup.failed")).toBe("Backup failed: {reason}")
    expect(resolve("settings.backup.missing")).toBe("settings.backup.missing")
    expect(resolve("settings")).toBe("settings")
  })

  it("loads both locales' aggregate messages", async () => {
    const en = await loadMessageResolver("en")
    const zh = await loadMessageResolver("zh-CN")
    // A key that must exist in both aggregates — resolving to something other
    // than the key itself proves the tree loaded.
    const probe = "common.cancel"
    expect(en(probe)).not.toBe(probe)
    expect(zh(probe)).not.toBe(probe)
    expect(en(probe)).not.toBe(zh(probe))
  })
})
