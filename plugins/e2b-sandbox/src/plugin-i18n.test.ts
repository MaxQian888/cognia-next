import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import manifestJson from "../plugin.json"

const I18N_MESSAGES = manifestJson.i18n.locales

const SRC = join(__dirname)

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [full]
      : []
  })
}

describe("plugin.json i18n bundle", () => {
  const en = Object.keys(I18N_MESSAGES.en)
  const zh = Object.keys(I18N_MESSAGES["zh-CN"])

  it("uses bare keys — the manager prefixes `plugin.<id>.` on merge", () => {
    // An already-prefixed key would land double-prefixed in the merged host
    // bundle and resolve to nothing (the sre-agent accident this avoids).
    expect(en.every((key) => !key.startsWith("plugin."))).toBe(true)
    expect(zh.every((key) => !key.startsWith("plugin."))).toBe(true)
  })

  it("holds the same key set in both locales", () => {
    expect([...en].sort()).toEqual([...zh].sort())
  })

  it("leaves no string untranslated", () => {
    const zhBundle = I18N_MESSAGES["zh-CN"] as Record<string, string>
    const enBundle = I18N_MESSAGES.en as Record<string, string>
    // "API key" and "E2B Cloud" are the same in both locales by design —
    // whitelist them rather than weakening the drift check.
    const identical = en.filter(
      (key) =>
        zhBundle[key] === enBundle[key] &&
        key !== "panel.status.apiKey" &&
        key !== "panel.status.cloud"
    )
    expect(identical).toEqual([])
  })

  it("carries every key the command builds at runtime", () => {
    // `command.sandbox.key.${status}` is template-built — `lint:i18n` cannot
    // see it, so the family is enumerated here.
    const dynamic = ["keyring", "pending", "missing"].map((s) => `command.sandbox.key.${s}`)
    const missing = dynamic.filter((key) => !en.includes(key))
    expect(missing).toEqual([])
  })

  it("carries every literal key the source actually asks for", () => {
    const files = walk(SRC)
    const used = new Set<string>()
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(/\bt(?:ranslate)?\(\s*(?:locale,\s*)?"([^"$]+)"/g)) {
        used.add(match[1])
      }
    }
    expect(used.size).toBeGreaterThan(10)
    const missing = [...used].filter((key) => !en.includes(key))
    expect(missing).toEqual([])
  })

  it("declares no key nothing reads", () => {
    const files = walk(SRC)
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n")
    // The manifest's own nameKey / descriptionKey, and each command's
    // descriptionKey (the `/` picker), read their keys too.
    const manifestKeys = new Set<string | undefined>([
      manifestJson.nameKey,
      manifestJson.descriptionKey,
      ...(manifestJson.commands ?? []).map(
        (command: { descriptionKey?: string }) => command.descriptionKey
      ),
    ])
    const orphans = en.filter((key) => {
      if (manifestKeys.has(key)) return false
      if (source.includes(`"${key}"`)) return false
      // Template-built families: `command.sandbox.key.keyring` is reached as
      // `command.sandbox.key.${status.apiKey}` — try every prefix.
      const segments = key.split(".")
      return !segments.some((_segment, index) =>
        source.includes(`${segments.slice(0, index + 1).join(".")}.$`)
      )
    })
    expect(orphans).toEqual([])
  })
})
