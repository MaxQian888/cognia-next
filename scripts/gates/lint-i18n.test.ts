/**
 * Fixture-driven tests for the i18n lint internals. We exercise the public
 * helpers (`diffKeys`, `__internal.scanFile`, `__internal.isProseLiteral`)
 * with in-memory inputs rather than driving the CLI through child_process —
 * keeps the test runtime under a second and avoids cross-platform shell
 * differences.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { diffKeys, filterAgainstBaseline, parseArgs, __internal } from "./lint-i18n"

function withTempTsx(source: string, fn: (file: string) => void): void {
  const tmp = path.join(os.tmpdir(), `lint-i18n-${process.pid}-${Date.now()}.tsx`)
  fs.writeFileSync(tmp, source, "utf8")
  try {
    fn(tmp)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore cleanup failure on Windows file-lock races.
    }
  }
}

describe("diffKeys", () => {
  it("returns empty diffs when both bundles match", () => {
    const en = { a: "1", b: { c: "2" } }
    const zh = { a: "x", b: { c: "y" } }
    expect(diffKeys(en, zh)).toEqual({ onlyInEn: [], onlyInZh: [] })
  })

  it("reports keys present only in en", () => {
    const en = { a: "1", extra: "x" }
    const zh = { a: "x" }
    expect(diffKeys(en, zh)).toEqual({ onlyInEn: ["extra"], onlyInZh: [] })
  })

  it("reports keys present only in zh", () => {
    const en = { a: "1" }
    const zh = { a: "x", solo: "y" }
    expect(diffKeys(en, zh)).toEqual({ onlyInEn: [], onlyInZh: ["solo"] })
  })

  it("flattens nested objects to dot-paths", () => {
    const en = { settings: { a: "1", b: "2" } }
    const zh = { settings: { a: "x" } }
    expect(diffKeys(en, zh)).toEqual({ onlyInEn: ["settings.b"], onlyInZh: [] })
  })

  it("treats arrays as opaque leaves", () => {
    const en = { items: ["a", "b"] }
    const zh = { items: ["x"] }
    expect(diffKeys(en, zh)).toEqual({ onlyInEn: [], onlyInZh: [] })
  })
})

describe("parseArgs", () => {
  it("defaults both flags to false", () => {
    expect(parseArgs([])).toEqual({ writeBaseline: false, json: false })
  })

  it("recognises --write-baseline", () => {
    expect(parseArgs(["--write-baseline"])).toMatchObject({ writeBaseline: true })
  })

  it("recognises --json", () => {
    expect(parseArgs(["--json"])).toMatchObject({ json: true })
  })

  it("recognises both flags in either order", () => {
    expect(parseArgs(["--json", "--write-baseline"])).toEqual({
      writeBaseline: true,
      json: true,
    })
  })

  it("ignores unknown flags", () => {
    expect(parseArgs(["--bogus", "--json", "extra"])).toEqual({
      writeBaseline: false,
      json: true,
    })
  })
})

describe("filterAgainstBaseline", () => {
  it("passes the raw diff through when no baseline is provided", () => {
    const diff = { onlyInEn: ["a"], onlyInZh: ["b"] }
    expect(filterAgainstBaseline(diff, null)).toEqual(diff)
  })

  it("subtracts tolerated keys from the diff", () => {
    const diff = { onlyInEn: ["a", "new"], onlyInZh: ["b", "other"] }
    const baseline = {
      count: 0,
      samples: [],
      knownParityDrift: { onlyInEn: ["a"], onlyInZh: ["b"] },
    }
    expect(filterAgainstBaseline(diff, baseline)).toEqual({
      onlyInEn: ["new"],
      onlyInZh: ["other"],
    })
  })

  it("treats missing knownParityDrift as no tolerance", () => {
    const diff = { onlyInEn: ["a"], onlyInZh: [] }
    const baseline = { count: 0, samples: [] }
    expect(filterAgainstBaseline(diff, baseline)).toEqual(diff)
  })
})

describe("__internal.isProseLiteral", () => {
  it("rejects short strings", () => {
    expect(__internal.isProseLiteral("ab")).toBe(false)
    expect(__internal.isProseLiteral("xy")).toBe(false)
  })

  it("rejects pure punctuation and digits", () => {
    expect(__internal.isProseLiteral("12345")).toBe(false)
    expect(__internal.isProseLiteral("—— → ←")).toBe(false)
    expect(__internal.isProseLiteral("...")).toBe(false)
  })

  it("accepts English prose", () => {
    expect(__internal.isProseLiteral("Hello world")).toBe(true)
    expect(__internal.isProseLiteral("Click here")).toBe(true)
  })

  it("accepts Chinese prose", () => {
    expect(__internal.isProseLiteral("点击这里")).toBe(true)
  })

  it("trims surrounding whitespace before measuring length", () => {
    expect(__internal.isProseLiteral("  Hi  ")).toBe(false) // "Hi" too short
    expect(__internal.isProseLiteral("  Help  ")).toBe(true)
  })

  it("rejects URLs as technical placeholders", () => {
    expect(__internal.isProseLiteral("https://192.168.1.42:7891")).toBe(false)
    expect(__internal.isProseLiteral("http://localhost:3000")).toBe(false)
  })

  it("rejects bare host:port placeholders", () => {
    expect(__internal.isProseLiteral("localhost:3000")).toBe(false)
    expect(__internal.isProseLiteral("192.168.1.1:8080")).toBe(false)
  })

  it("rejects JWT-prefix placeholders", () => {
    expect(__internal.isProseLiteral("eyJ...")).toBe(false)
    expect(__internal.isProseLiteral("eyJhbGciOiJI")).toBe(false)
  })

  it("rejects model-id style placeholders", () => {
    expect(__internal.isProseLiteral("claude-sonnet-4-6")).toBe(false)
    expect(__internal.isProseLiteral("gpt-4-mini")).toBe(false)
    expect(__internal.isProseLiteral("text-embedding-3-large")).toBe(false)
  })

  it("still flags prose that happens to contain dashes", () => {
    expect(__internal.isProseLiteral("Click here to retry")).toBe(true)
    expect(__internal.isProseLiteral("auto-save enabled")).toBe(true)
  })
})

describe("__internal.scanFile", () => {
  it("flags JSX text nodes that are prose", () => {
    const src = `
      export function Comp() {
        return <div>Hello world</div>
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(1)
      expect(findings[0]).toMatchObject({
        context: "jsx-text",
        text: "Hello world",
      })
    })
  })

  it("flags hardcoded `placeholder` attributes", () => {
    const src = `
      export function Comp() {
        return <input placeholder="Type your name" />
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(1)
      expect(findings[0].context).toBe("placeholder")
      expect(findings[0].text).toBe("Type your name")
    })
  })

  it("flags hardcoded `aria-label` attributes", () => {
    const src = `
      export function Comp() {
        return <button aria-label="Close dialog" />
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(1)
      expect(findings[0].context).toBe("aria-label")
    })
  })

  it("flags string-literal expressions inside JSX attribute braces", () => {
    const src = `
      export function Comp() {
        return <input placeholder={"Inline literal text"} />
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(1)
      expect(findings[0].context).toBe("placeholder")
    })
  })

  it("does NOT flag t(...) call expressions used for placeholder", () => {
    const src = `
      const t = (s: string) => s
      export function Comp() {
        return <input placeholder={t("placeholder.key")} />
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(0)
    })
  })

  it("does NOT flag non-prose JSX text (digits, single chars)", () => {
    const src = `
      export function Comp() {
        return <span>123</span>
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(0)
    })
  })

  it("ignores non-visible attribute strings (className, data-testid, etc.)", () => {
    const src = `
      export function Comp() {
        return <button className="bg-red-500 text-white" data-testid="my-btn" />
      }
    `
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings).toHaveLength(0)
    })
  })

  it("records 1-based line + column on each finding", () => {
    const src = `export function C() { return <div>Hello there</div> }`
    withTempTsx(src, (file) => {
      const findings = __internal.scanFile(file)
      expect(findings[0].line).toBe(1)
      expect(findings[0].column).toBeGreaterThan(0)
    })
  })
})

describe("__internal.shouldIgnoreFile", () => {
  it("auto-ignores vendored shadcn components/ui paths", () => {
    expect(__internal.shouldIgnoreFile("components/ui/button.tsx", [])).toBe(true)
  })

  it("auto-ignores vendored ai-elements paths", () => {
    expect(__internal.shouldIgnoreFile("components/ai-elements/conversation.tsx", [])).toBe(true)
  })

  it("respects custom substring ignore globs", () => {
    expect(__internal.shouldIgnoreFile("components/legacy/foo.tsx", ["legacy/"])).toBe(true)
    expect(__internal.shouldIgnoreFile("components/legacy/foo.tsx", [])).toBe(false)
  })

  it("treats blank and comment lines in the ignore file as no-ops", () => {
    expect(
      __internal.shouldIgnoreFile("components/inbox/conversation-list.tsx", ["", "#comment"])
    ).toBe(false)
  })
})
