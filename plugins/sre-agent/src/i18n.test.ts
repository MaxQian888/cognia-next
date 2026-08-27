import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { I18N_MESSAGES } from "./i18n"
import { PLUGIN_ID } from "./ids"

const PREFIX = `plugin.${PLUGIN_ID}.`
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

describe("plugin i18n bundle", () => {
  const en = Object.keys(I18N_MESSAGES.en)
  const zh = Object.keys(I18N_MESSAGES["zh-CN"])

  it("keys every string under this plugin's namespace", () => {
    expect(en.every((key) => key.startsWith(PREFIX))).toBe(true)
  })

  it("holds the same key set in both locales", () => {
    expect([...en].sort()).toEqual([...zh].sort())
  })

  it("leaves no string untranslated", () => {
    const untranslated = en.filter(
      (key) =>
        I18N_MESSAGES["zh-CN"][key as keyof (typeof I18N_MESSAGES)["zh-CN"]] ===
        I18N_MESSAGES.en[key as keyof (typeof I18N_MESSAGES)["en"]]
    )
    expect(untranslated).toEqual([])
  })

  /**
   * `lint:i18n` cannot see a key built at runtime (`t(\`status.${x}\`)`), which
   * is exactly how a status label ships as its own raw key string. Every
   * template-built key family the panel uses is enumerated here instead.
   */
  it("carries every key the panel builds at runtime", () => {
    const dynamic = [
      ...["scope", "evidence", "attribution", "conclusion"].map((p) => `phase.${p}`),
      ...["investigating", "unconfirmed", "resolved", "dismissed"].map((s) => `status.${s}`),
      ...["info", "warning", "critical"].map((s) => `severity.${s}`),
      ...["investigating", "unconfirmed", "closed"].map((g) => `list.filter.${g}`),
      ...["healthy", "lagging", "stalled", "static"].map((s) => `sources.status.${s}`),
      ...["timeline.empty", "validation.missing", "validation.failed", "status.closed"].map(
        (b) => `conclusion.blocked.${b}`
      ),
    ]
    const missing = dynamic.filter((key) => !en.includes(`${PREFIX}${key}`))
    expect(missing).toEqual([])
  })

  it("carries every literal key the source actually asks for", () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(5)
    const used = new Set<string>()
    for (const file of files) {
      const source = readFileSync(file, "utf8")
      for (const match of source.matchAll(/\bt\(\s*"([^"$]+)"/g)) used.add(match[1])
    }
    expect(used.size).toBeGreaterThan(20)
    const missing = [...used].filter((key) => !en.includes(`${PREFIX}${key}`))
    expect(missing).toEqual([])
  })

  it("declares no key nothing reads", () => {
    const files = walk(SRC)
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n")
    const orphans = en
      .map((key) => key.slice(PREFIX.length))
      .filter((key) => {
        if (source.includes(`"${key}"`)) return false
        // Template-built families: `phase.scope` is reached as `phase.${phase}`,
        // and `conclusion.blocked.timeline.empty` as `conclusion.blocked.${b}` —
        // so every prefix has to be tried, not just the longest one.
        const segments = key.split(".")
        return !segments.some((_segment, index) =>
          source.includes(`${segments.slice(0, index + 1).join(".")}.$`)
        )
      })
    expect(orphans).toEqual([])
  })
})
