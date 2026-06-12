import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  auditContractPaths,
  newPhantomPaths,
  stalePhantomAllowlist,
  KNOWN_PHANTOM_PATHS,
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
// capability is stamped "verified" against a file that is not there. The gate
// is a self-ratcheting burndown:
//
//   1. No phantom path may exist OUTSIDE the KNOWN_PHANTOM_PATHS allowlist —
//      this blocks any NEW rot.
//   2. No allowlist entry may be stale (already fixed) — this forces the list
//      to shrink as paths are corrected/created, never to drift.
//
// Fix a phantom by correcting the contract path or creating the missing
// artifact, then delete its entry from KNOWN_PHANTOM_PATHS. Never weaken these
// assertions; the end state is an empty allowlist.
describe("plugin capability contracts — phantom proof-path gate", () => {
  it("introduces no phantom path outside the burndown allowlist", () => {
    const fresh = newPhantomPaths(REPO_ROOT)
    if (fresh.length > 0) {
      throw new Error(
        `${fresh.length} NEW phantom contract proof path(s) — add the real file or fix the contract:\n${formatPhantomReport(fresh)}`
      )
    }
    expect(fresh).toEqual([])
  })

  it("has no stale allowlist entries (each known phantom is still missing)", () => {
    const stale = stalePhantomAllowlist(REPO_ROOT)
    if (stale.length > 0) {
      throw new Error(
        `${stale.length} allowlist entr(y/ies) now resolve — delete them from KNOWN_PHANTOM_PATHS:\n  ${stale.join("\n  ")}`
      )
    }
    expect(stale).toEqual([])
  })

  it("allowlist only contains genuinely-phantom paths (sanity)", () => {
    // Every allowlisted path must currently appear in the raw phantom set.
    const all = new Set(auditContractPaths(REPO_ROOT).map((p) => p.path))
    for (const known of KNOWN_PHANTOM_PATHS) {
      expect(all.has(known)).toBe(true)
    }
  })
})
