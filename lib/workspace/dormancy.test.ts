/**
 * Three-axis guard for this subsystem's deliberate dormancy (Working Rule 7).
 *
 * The rule: intentional dormancy must be documented at the TYPE, labeled inert
 * in the UI, and pinned by a TEST. Any two of three is a latent bug — a
 * documented-but-unlabeled exclusion looks like an oversight to the user, and
 * an unpinned one gets "fixed" by the next person who reads the type as a TODO.
 *
 * Two dormancies were introduced deliberately here, and both are the kind that
 * would otherwise be quietly reversed:
 *
 *  1. **Plugins are not in the capability overlay.** `plugins.enabled` is the
 *     runtime's loaded state, written by `manager.setPluginIntent` as a
 *     consequence of activation, so overlaying it per workspace would rewrite
 *     the record of what is actually running on every switch.
 *
 *  2. **Execution panels cannot be pinned.** A terminal pinned to a directory
 *     the agent is not working in is a loaded gun, so `resolvePanelRoot`
 *     IGNORES such a pin rather than obeying it.
 *
 * The file scan is deliberately counted: an assertion that a walk found nothing
 * also passes when the walk found no files at all.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolvePanelRoot, FOLLOWING_PANELS, isPinnablePanel } from "./panel-follow"
import { WORKSPACE_CAPABILITY_KINDS } from "./capability-overlay"

function read(relPath: string): string {
  const full = join(process.cwd(), relPath)
  // A guard that silently reads nothing is the failure mode this whole file
  // exists to avoid, so a missing file is a loud failure, not an empty string.
  expect({ relPath, exists: existsSync(full) }).toEqual({ relPath, exists: true })
  return readFileSync(full, "utf8")
}

describe("plugins stay machine-wide", () => {
  it("axis 1 — the type says so, with the reason", () => {
    const source = read("lib/workspace/capability-overlay.ts")
    expect(source).toContain("Why plugins are not here")
    expect(source).toContain("setPluginIntent")
  })

  it("axis 2 — the UI says so rather than showing a dead control", () => {
    const panel = read("components/workspace/workspace-capabilities.tsx")
    expect(panel).toContain("pluginsAreGlobal")
    // A greyed-out row would read as "coming soon"; a statement does not.
    expect(panel).not.toMatch(/kind=["']plugin["']/)
  })

  it("axis 3 — the kind list excludes it, in code rather than by convention", () => {
    expect([...WORKSPACE_CAPABILITY_KINDS]).not.toContain("plugin")
  })

  it("has a message for the statement in both locales", () => {
    for (const locale of ["en", "zh-CN"]) {
      const messages = JSON.parse(read(`i18n/messages/${locale}/workspace.json`))
      expect(messages.capabilities?.pluginsAreGlobal).toBeTruthy()
    }
  })
})

describe("execution panels cannot be pinned", () => {
  it("axis 1 — the type documents the refusal and why", () => {
    const source = read("lib/workspace/panel-follow.ts")
    expect(source).toContain("Execution panels")
    expect(source).toContain("loaded gun")
  })

  it("axis 2 — the chip renders no pin control for one", () => {
    const chip = read("components/workspace/panel-root-chip.tsx")
    expect(chip).toContain("isPinnablePanel")
    // Guarded on the classification, not only on the handler being passed:
    // a caller that passes one anyway must still get no control.
    expect(chip).toMatch(/pinnable && onTogglePin/)
  })

  it("axis 3 — the resolver ignores a pin on one", () => {
    const scanned = FOLLOWING_PANELS.map((panel) => {
      expect(isPinnablePanel(panel)).toBe(false)
      return resolvePanelRoot({
        panel,
        pinnedRoot: "/somewhere/else",
        activeProject: { roots: [{ id: "r", path: "/repos/app", isPrimary: true }] },
      })
    })
    // Counted, so a shrunk union cannot make this pass by scanning nothing.
    expect(scanned).toHaveLength(FOLLOWING_PANELS.length)
    expect(scanned.length).toBeGreaterThan(0)
    for (const target of scanned) {
      expect(target.source).not.toBe("pinned")
      expect(target.root).toBe("/repos/app")
    }
  })
})
