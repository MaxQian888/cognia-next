import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  evaluateAuditFromSources,
  parseBindingPaths,
  runAudit,
  type ComputedAttribute,
  type DiscoveredMount,
} from "./audit-plugin-slots"
import type { PluginPointContract } from "../../lib/plugin/contracts/plugin-points"

function mockContract(
  id: string,
  status: PluginPointContract["status"],
  stability: PluginPointContract["stability"] = "stable",
  binding = `components/host/${id}.tsx`
): PluginPointContract {
  return {
    id,
    kind: "ui-slot",
    stability,
    status,
    owner: "test",
    binding,
    docs: "docs",
    requiredTests: [],
    introducedIn: "0.1.0",
  }
}

function mockMount(point: string, file: string, line = 10): DiscoveredMount {
  return {
    point,
    filePath: path.normalize(file),
    line,
    column: 1,
    componentName: "PluginExtensionSlot",
  }
}

const repoRoot = process.platform === "win32" ? "C:\\repo" : "/repo"

describe("audit-plugin-slots: evaluateAuditFromSources", () => {
  it("happy path: implemented + matching mount = no errors, no warnings", () => {
    const contract = mockContract("X", "implemented", "stable", "components/host/X.tsx")
    const mounts = [mockMount("X", path.join(repoRoot, "components/host/X.tsx"))]
    const report = evaluateAuditFromSources(mounts, [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it("implemented + unmounted = error", () => {
    const contract = mockContract("X", "implemented")
    const report = evaluateAuditFromSources([], [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([expect.stringContaining("[implemented-unmounted]")])
    expect(report.errors[0]).toContain('"X"')
  })

  it("deprecated + unmounted = silent", () => {
    const contract = mockContract("X", "deprecated", "deprecated")
    const report = evaluateAuditFromSources([], [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it("deprecated + mounted = warning (not error)", () => {
    const contract = mockContract("X", "deprecated", "deprecated")
    const mounts = [mockMount("X", path.join(repoRoot, "components/host/X.tsx"), 42)]
    const report = evaluateAuditFromSources(mounts, [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([expect.stringContaining("[deprecated-mounted]")])
    expect(report.warnings[0]).toContain(":42")
  })

  it("virtual (experimental) + unmounted = warning", () => {
    const contract = mockContract("X", "virtual", "experimental")
    const report = evaluateAuditFromSources([], [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([expect.stringContaining("[experimental-unmounted]")])
  })

  it("computed attribute = error", () => {
    const computed: ComputedAttribute[] = [
      {
        filePath: path.join(repoRoot, "components/foo.tsx"),
        line: 5,
        column: 7,
        componentName: "PluginExtensionSlot",
      },
    ]
    const report = evaluateAuditFromSources([], computed, {
      repoRoot,
      canonicalPoints: [],
      getContract: () => undefined,
    })
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([expect.stringContaining("[computed-point]")])
    expect(report.errors[0]).toContain("components/foo.tsx:5:7")
  })

  it("binding drift = error", () => {
    const contract = mockContract("X", "implemented", "stable", "components/host/correct.tsx")
    const mounts = [mockMount("X", path.join(repoRoot, "components/host/wrong.tsx"))]
    const report = evaluateAuditFromSources(mounts, [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([expect.stringContaining("[binding-drift]")])
    expect(report.errors[0]).toContain("components/host/correct.tsx")
    expect(report.errors[0]).toContain("components/host/wrong.tsx")
  })

  it("multi-host binding: all declared hosts mounted = no drift", () => {
    const contract = mockContract(
      "X",
      "implemented",
      "stable",
      "components/shell/guild-rail.tsx + components/shell/sidebar-footer.tsx"
    )
    const mounts = [
      mockMount("X", path.join(repoRoot, "components/shell/guild-rail.tsx")),
      mockMount("X", path.join(repoRoot, "components/shell/sidebar-footer.tsx"), 32),
    ]
    const report = evaluateAuditFromSources(mounts, [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
  })

  it("multi-host binding: one declared host lost its mount = drift naming that host", () => {
    const contract = mockContract(
      "X",
      "implemented",
      "stable",
      "components/shell/guild-rail.tsx + components/shell/sidebar-footer.tsx"
    )
    const mounts = [mockMount("X", path.join(repoRoot, "components/shell/guild-rail.tsx"))]
    const report = evaluateAuditFromSources(mounts, [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual([expect.stringContaining("[binding-drift]")])
    expect(report.errors[0]).toContain("components/shell/sidebar-footer.tsx")
    // The host that IS mounted must not be reported as missing.
    expect(report.errors[0]).not.toContain("for components/shell/guild-rail.tsx")
  })

  it("parseBindingPaths splits a joined binding and leaves a single one intact", () => {
    expect(parseBindingPaths("components/a.tsx + components/b.tsx")).toEqual([
      "components/a.tsx",
      "components/b.tsx",
    ])
    expect(parseBindingPaths("components/a.tsx")).toEqual(["components/a.tsx"])
    expect(parseBindingPaths("  components/a.tsx  +  ")).toEqual(["components/a.tsx"])
  })

  it("registration host with existing binding file = no error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reg-ok-"))
    try {
      const bindingRel = "components/host/registration.tsx"
      const absBinding = path.join(tmp, bindingRel)
      fs.mkdirSync(path.dirname(absBinding), { recursive: true })
      fs.writeFileSync(absBinding, "export {}\n")

      const contract: PluginPointContract = {
        ...mockContract("R", "implemented", "stable", bindingRel),
        hostKind: "registration",
      }
      const report = evaluateAuditFromSources([], [], {
        repoRoot: tmp,
        canonicalPoints: ["R"],
        getContract: () => contract,
      })
      expect(report.ok).toBe(true)
      expect(report.errors).toEqual([])
      expect(report.entries[0].hostKind).toBe("registration")
      expect(report.entries[0].registrationBindingMissing).toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("registration host with missing binding file = error", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reg-miss-"))
    try {
      const contract: PluginPointContract = {
        ...mockContract("R", "implemented", "stable", "components/host/does-not-exist.tsx"),
        hostKind: "registration",
      }
      const report = evaluateAuditFromSources([], [], {
        repoRoot: tmp,
        canonicalPoints: ["R"],
        getContract: () => contract,
      })
      expect(report.ok).toBe(false)
      expect(report.errors).toEqual([expect.stringContaining("[registration-host-missing]")])
      expect(report.entries[0].registrationBindingMissing).toBe(true)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("registration host does not require any JSX mount (and ignores unrelated drift)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-reg-nojsx-"))
    try {
      const bindingRel = "components/host/registration.tsx"
      fs.mkdirSync(path.join(tmp, "components/host"), { recursive: true })
      fs.writeFileSync(path.join(tmp, bindingRel), "export {}\n")

      const contract: PluginPointContract = {
        ...mockContract("R", "implemented", "stable", bindingRel),
        hostKind: "registration",
      }
      const report = evaluateAuditFromSources([], [], {
        repoRoot: tmp,
        canonicalPoints: ["R"],
        getContract: () => contract,
      })
      // Neither "[implemented-unmounted]" nor "[binding-drift]" should fire
      // for a registration host even though zero JSX mounts were found.
      expect(report.ok).toBe(true)
      expect(report.errors).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("unknown point in mounts = error", () => {
    const contract = mockContract("X", "implemented")
    const mounts = [
      mockMount("X", path.join(repoRoot, "components/host/X.tsx")),
      mockMount("Z", path.join(repoRoot, "components/host/foo.tsx"), 22),
    ]
    const report = evaluateAuditFromSources(mounts, [], {
      repoRoot,
      canonicalPoints: ["X"],
      getContract: () => contract,
    })
    expect(report.ok).toBe(false)
    const unknownErr = report.errors.find((e) => e.includes("[unknown-point]"))
    expect(unknownErr).toBeDefined()
    expect(unknownErr).toContain('"Z"')
  })
})

describe("audit-plugin-slots: runAudit (filesystem)", () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "audit-slots-"))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("walks app/ + components/ + lib/ and finds PluginExtensionSlot mounts", () => {
    const compDir = path.join(tmpRoot, "components", "host")
    fs.mkdirSync(compDir, { recursive: true })
    fs.writeFileSync(
      path.join(compDir, "X.tsx"),
      `import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
export function Host() {
  return <PluginExtensionSlot point="X" />
}
`
    )
    const report = runAudit({
      repoRoot: tmpRoot,
      canonicalPoints: ["X"],
      getContract: () => mockContract("X", "implemented", "stable", "components/host/X.tsx"),
    })
    expect(report.ok).toBe(true)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].mounts).toHaveLength(1)
    expect(report.entries[0].mounts[0].point).toBe("X")
  })

  it("recognizes PluginExtensionSlotWithOverflow as a wrapper", () => {
    const compDir = path.join(tmpRoot, "components")
    fs.mkdirSync(compDir, { recursive: true })
    fs.writeFileSync(
      path.join(compDir, "wrapper.tsx"),
      `export function W() {
  return <PluginExtensionSlotWithOverflow point="Y" limit={3} />
}
`
    )
    const report = runAudit({
      repoRoot: tmpRoot,
      canonicalPoints: ["Y"],
      getContract: () => mockContract("Y", "implemented", "stable", "components/wrapper.tsx"),
    })
    expect(report.ok).toBe(true)
    expect(report.entries[0].mounts).toHaveLength(1)
    expect(report.entries[0].mounts[0].componentName).toBe("PluginExtensionSlotWithOverflow")
  })

  it("rejects computed point attributes from real source files", () => {
    const compDir = path.join(tmpRoot, "components")
    fs.mkdirSync(compDir, { recursive: true })
    fs.writeFileSync(
      path.join(compDir, "bad.tsx"),
      `const POINT = "Z"
export function Bad() {
  return <PluginExtensionSlot point={POINT} />
}
`
    )
    const report = runAudit({
      repoRoot: tmpRoot,
      canonicalPoints: ["Z"],
      getContract: () => mockContract("Z", "implemented", "stable", "components/bad.tsx"),
    })
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[computed-point]"),
        // Implemented-but-unmounted because the computed attribute didn't count.
        expect.stringContaining("[implemented-unmounted]"),
      ])
    )
  })

  it("skips test files (*.test.tsx)", () => {
    const compDir = path.join(tmpRoot, "components")
    fs.mkdirSync(compDir, { recursive: true })
    fs.writeFileSync(
      path.join(compDir, "Host.test.tsx"),
      `export function HostTest() {
  return <PluginExtensionSlot point="ignored" />
}
`
    )
    const report = runAudit({
      repoRoot: tmpRoot,
      canonicalPoints: ["ignored"],
      getContract: () => mockContract("ignored", "implemented"),
    })
    // Implementation needs a real mount; the test file shouldn't satisfy it.
    expect(report.errors).toEqual([expect.stringContaining("[implemented-unmounted]")])
  })

  it("emits PASS line for the real production codebase", () => {
    // Cheap canary: the real codebase audit must always be runnable from
    // tests so CI never accidentally short-circuits on environment drift.
    const report = runAudit(process.cwd())
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
  })
})
