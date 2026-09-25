import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import manifestJson from "../plugin.json"

const SRC = join(__dirname)
const en: Record<string, string> = manifestJson.i18n.locales.en
const zh: Record<string, string> = manifestJson.i18n.locales["zh-CN"]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test(-helpers)?\./.test(entry.name)
      ? [full]
      : []
  })
}

describe("plugin i18n bundle (plugin.json)", () => {
  it("uses flat keys — the manager adds the plugin.sre-agent. prefix", () => {
    expect(Object.keys(en).every((key) => !key.startsWith("plugin."))).toBe(true)
  })

  it("holds the same key set in both locales", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it("leaves no string untranslated", () => {
    // `detail.windowRange` is pure interpolation, identical in every language.
    const identical = Object.keys(en).filter(
      (key) => zh[key] === en[key] && key !== "detail.windowRange"
    )
    expect(identical).toEqual([])
  })

  it("keeps every placeholder in both locales", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(en)) {
      expect({ key, placeholders: placeholders(zh[key]) }).toEqual({
        key,
        placeholders: placeholders(en[key]),
      })
    }
  })

  /**
   * `lint:i18n` cannot see a key built at runtime (`t(\`status.${x}\`)`), which
   * is exactly how a status label ships as its own raw key string. Every
   * template-built key family the panel uses is enumerated here instead.
   */
  it("carries every key the panel builds at runtime", () => {
    const validationCodes = [
      "timeline.empty",
      "row.invalid",
      "row.evidence_missing",
      "row.confidence_invalid",
      "row.evidence_unknown",
      "row.source_uncited",
      "row.metrics_only_event",
      "row.component_unsupported",
      "row.claim_unsupported",
      "row.event_unsupported",
      "row.sensitive_text",
      "finding.evidence_unknown",
      "finding.sensitive_text",
    ]
    const dynamic = [
      ...["scope", "evidence", "attribution", "conclusion"].map((p) => `phase.${p}`),
      ...["investigating", "unconfirmed", "resolved", "dismissed"].map((s) => `status.${s}`),
      ...["info", "warning", "critical"].map((s) => `severity.${s}`),
      ...["investigating", "unconfirmed", "closed"].map((g) => `list.filter.${g}`),
      ...["healthy", "lagging", "stalled", "static"].map((s) => `sources.status.${s}`),
      ...["timeline.empty", "validation.missing", "validation.failed", "status.closed"].map(
        (b) => `conclusion.blocked.${b}`
      ),
      ...validationCodes.map((code) => `validation.${code}`),
      ...["error.save", "error.delete", "error.pin", "error.validate"],
    ]
    expect(dynamic.filter((key) => !(key in en))).toEqual([])
  })

  it("translates every code the validator can emit", () => {
    const validator = readFileSync(join(SRC, "validator.ts"), "utf8")
    const codes = [...validator.matchAll(/issue\(\s*"([^"]+)"/g)].map((match) => match[1])
    expect(codes.length).toBeGreaterThan(10)
    expect(codes.filter((code) => !(`validation.${code}` in en))).toEqual([])
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
    expect([...used].filter((key) => !(key in en))).toEqual([])
  })

  it("declares no key nothing reads", () => {
    const source = walk(SRC)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    // The manifest's own nameKey / descriptionKey read their keys too.
    const manifestKeys = new Set([manifestJson.nameKey, manifestJson.descriptionKey])
    const orphans = Object.keys(en).filter((key) => {
      if (manifestKeys.has(key)) return false
      if (source.includes(`"${key}"`)) return false
      // Template-built families: `phase.scope` is reached as `phase.${phase}`,
      // and `validation.row.evidence_unknown` as `validation.${issue.code}` —
      // so every prefix has to be tried, not just the longest one.
      const segments = key.split(".")
      return !segments.some((_segment, index) =>
        source.includes(`${segments.slice(0, index + 1).join(".")}.$`)
      )
    })
    expect(orphans).toEqual([])
  })
})
