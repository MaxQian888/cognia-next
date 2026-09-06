/**
 * @jest-environment jsdom
 */
/**
 * Capability-declaration parity for the node catalog.
 *
 * `effectiveRequires` (./catalog.ts) falls back to `["shell"]` for an entry
 * that carries a bare `desktopOnly: true` and no `requires`. ADR-0061
 * justified that mapping with "`shell` is present exactly on the tauri
 * baseline, so `desktopOnly` is tauri-only".
 *
 * That justification no longer holds. `shell` is also in the headless
 * `SERVER_BACKED` baseline (`lib/platform/capabilities.ts`), so a bare
 * `desktopOnly` node passes `capability-preflight.ts` on the cloud brain and
 * then throws from inside its executor, halfway through a run that has already
 * had side effects. That is the exact failure the preflight exists to prevent.
 *
 * Every current entry happens to carry an explicit `requires`, so nothing is
 * broken today. This test is what stops the next one from relying on the bare
 * flag.
 */
import "fake-indexeddb/auto"
import { effectiveRequires, nodeCatalogEntry } from "./catalog"
import { isCapabilityId } from "@/lib/platform/capabilities"
import { WORKFLOW_NODE_KINDS } from "@/types/workflow/visual"

describe("node catalog capability declarations", () => {
  it("never lets a desktop-only entry rely on the bare-flag fallback", () => {
    const bare = WORKFLOW_NODE_KINDS.filter((kind) => {
      const entry = nodeCatalogEntry(kind)
      return entry.desktopOnly === true && entry.requires === undefined
    })
    expect(bare).toEqual([])
  })

  it("declares only well-formed capability ids", () => {
    const malformed: Array<[string, unknown]> = []
    for (const kind of WORKFLOW_NODE_KINDS) {
      for (const cap of nodeCatalogEntry(kind).requires ?? []) {
        if (!isCapabilityId(cap)) malformed.push([kind, cap])
      }
    }
    expect(malformed).toEqual([])
  })

  /**
   * Guards the two assertions above from being satisfied by an empty walk:
   * `nodeCatalogEntry` synthesizes a stub for an unknown kind, so a broken
   * iteration would produce zero findings and read as a pass.
   */
  it("actually walks a populated catalog", () => {
    expect(WORKFLOW_NODE_KINDS.length).toBeGreaterThan(150)
    const declared = WORKFLOW_NODE_KINDS.filter(
      (kind) => (nodeCatalogEntry(kind).requires ?? []).length > 0
    )
    expect(declared.length).toBeGreaterThan(20)
  })

  it("resolves a desktop-only entry through its own requires, not the fallback", () => {
    // `effectiveRequires` prefers `requires` when present. Pinning one real
    // entry keeps the two paths distinguishable: `action.editor.open` needs
    // `pro-ide`, which the fallback would never have produced.
    expect(effectiveRequires(nodeCatalogEntry("action.editor.open"))).toEqual(["pro-ide"])
    expect(effectiveRequires({ desktopOnly: true })).toEqual(["shell"])
  })
})
