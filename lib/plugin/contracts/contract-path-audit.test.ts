import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  auditContractPaths,
  stripPathAnchor,
  formatPhantomReport,
  REPO_ROOT,
  type PhantomContractPath,
} from "./contract-path-audit"

describe("stripPathAnchor", () => {
  it("strips a docs '#anchor' suffix", () => {
    expect(stripPathAnchor("docs/x.md#capabilities")).toBe("docs/x.md")
  })

  it("strips a ':line' / ':line-range' suffix", () => {
    expect(stripPathAnchor("lib/a.ts:42")).toBe("lib/a.ts")
    expect(stripPathAnchor("lib/a.ts:42-50")).toBe("lib/a.ts")
  })

  it("trims surrounding whitespace and leaves clean paths intact", () => {
    expect(stripPathAnchor("  lib/a.ts  ")).toBe("lib/a.ts")
    expect(stripPathAnchor("plugins/web-tools/src/index.ts")).toBe("plugins/web-tools/src/index.ts")
  })
})

describe("auditContractPaths (synthetic root)", () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "contract-paths-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("reports every contract path that does not resolve against the root", () => {
    // An empty root means every real contract path is phantom — proving the
    // audit actually probes the filesystem rather than checking non-empty.
    const phantom = auditContractPaths(root)
    expect(phantom.length).toBeGreaterThan(0)
    expect(phantom.every((p) => !existsSync(join(root, p.path)))).toBe(true)
  })

  it("does NOT report a path once the file exists on disk", () => {
    // Materialize one known contract path and confirm it drops out of the report.
    const target = "lib/plugin/core/registry.ts"
    mkdirSync(join(root, "lib/plugin/core"), { recursive: true })
    writeFileSync(join(root, target), "// stub")
    const phantom = auditContractPaths(root)
    expect(phantom.some((p) => p.path === target)).toBe(false)
  })
})

describe("formatPhantomReport", () => {
  it("groups phantom entries by contract id", () => {
    const phantom: PhantomContractPath[] = [
      { contractId: "tools", field: "pythonSdk", raw: "a.py", path: "a.py" },
      { contractId: "tools", field: "docs", raw: "b.md#x", path: "b.md" },
      { contractId: "modes", field: "typescriptSdk", raw: "c.ts", path: "c.ts" },
    ]
    const report = formatPhantomReport(phantom)
    expect(report).toContain("[tools]")
    expect(report).toContain("pythonSdk: a.py")
    expect(report).toContain("[modes]")
  })
})

// The governance gate. A contract proof path that does not exist means a
// capability is stamped "verified" against a file that is not there. The
// burndown allowlist that once tolerated known-absent paths has been emptied
// and removed, so the gate is now absolute: EVERY contract proof path must
// resolve on disk. Fix a failure by correcting the contract path or creating
// the missing artifact — never re-introduce an allowlist.
describe("plugin capability contracts — phantom proof-path gate", () => {
  it("has zero phantom contract proof paths", () => {
    const phantom = auditContractPaths(REPO_ROOT)
    if (phantom.length > 0) {
      throw new Error(
        `${phantom.length} phantom contract proof path(s) — add the real file or fix the contract:\n${formatPhantomReport(phantom)}`
      )
    }
    expect(phantom).toEqual([])
  })
})
