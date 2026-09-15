import type { ProjectRuntimeSelection } from "@/types/project-environment"

import {
  assertRuntimeSelection,
  isValidCatalogEntryId,
  isValidEnvironmentSlug,
  runtimeSelectionProblems,
} from "./runtime-selection"

const full: ProjectRuntimeSelection = {
  source: { kind: "catalog", catalogEntryId: "python-3.12" },
  sizeClassId: "medium-4c8g",
  lifecycle: "ephemeral",
  isolationMinimum: "gvisor",
  bundlePin: { digest: `sha256:${"a".repeat(64)}`, releaseTag: "v1.2.0" },
  egressPresetIds: ["npm-mirror", "github"],
  browserSidecar: true,
  localContainer: false,
  updatedAt: 1_700_000_000_000,
}

function fields(selection: unknown) {
  return runtimeSelectionProblems(selection).map((problem) => problem.field)
}

describe("runtimeSelectionProblems", () => {
  it("accepts a full selection and the minimal auto one", () => {
    expect(runtimeSelectionProblems(full)).toEqual([])
    expect(runtimeSelectionProblems({ source: { kind: "auto" }, updatedAt: 1 })).toEqual([])
  })

  it("mirrors the Rust id grammars", () => {
    expect(isValidCatalogEntryId("legacy-env")).toBe(true)
    expect(isValidCatalogEntryId("node.22_lts")).toBe(true)
    expect(isValidCatalogEntryId("Node")).toBe(false)
    expect(isValidCatalogEntryId("-node")).toBe(false)
    expect(isValidCatalogEntryId("a".repeat(65))).toBe(false)
    expect(isValidEnvironmentSlug("medium-4c8g")).toBe(true)
    expect(isValidEnvironmentSlug("medium.4c")).toBe(false)
    expect(isValidEnvironmentSlug("a".repeat(64))).toBe(false)
  })

  it("reports every malformed field at once", () => {
    expect(
      fields({
        source: { kind: "catalog", catalogEntryId: "Python" },
        sizeClassId: "Large",
        lifecycle: "forever",
        isolationMinimum: "kata",
        bundlePin: { digest: "v1", releaseTag: " " },
        egressPresetIds: ["github", "github", "Bad"],
        browserSidecar: "yes",
        localContainer: 1,
        updatedAt: Number.NaN,
        image: "node:22",
      })
    ).toEqual([
      "image",
      "source.catalogEntryId",
      "sizeClassId",
      "lifecycle",
      "isolationMinimum",
      "bundlePin.digest",
      "bundlePin.releaseTag",
      "egressPresetIds[1]",
      "egressPresetIds[2]",
      "browserSidecar",
      "localContainer",
      "updatedAt",
    ])
  })

  it("keeps the source union closed", () => {
    expect(fields({ source: { kind: "auto", catalogEntryId: "x" }, updatedAt: 1 })).toEqual([
      "source",
    ])
    expect(fields({ source: { kind: "declaration" }, updatedAt: 1 })).toEqual(["source.kind"])
    expect(fields({ source: "auto", updatedAt: 1 })).toEqual(["source"])
    expect(
      fields({ ...full, bundlePin: { ...full.bundlePin, pinned: true }, egressPresetIds: "github" })
    ).toEqual(["bundlePin", "egressPresetIds"])
  })

  it("caps the preset count at the spec limit", () => {
    const ids = Array.from({ length: 65 }, (_, index) => `p${index}`)
    expect(fields({ ...full, egressPresetIds: ids })).toEqual(["egressPresetIds"])
  })

  it("refuses a non-object selection", () => {
    expect(fields(null)).toEqual(["runtime"])
    expect(fields([])).toEqual(["runtime"])
  })
})

describe("assertRuntimeSelection", () => {
  it("passes a valid selection and lists every problem otherwise", () => {
    expect(() => assertRuntimeSelection(full)).not.toThrow()
    expect(() => assertRuntimeSelection({ ...full, lifecycle: "x", sizeClassId: "X" })).toThrow(
      "runtime.sizeClassId must be a size class id; runtime.lifecycle must be persistent or ephemeral"
    )
    expect(() => assertRuntimeSelection("auto")).toThrow("runtime must be an object")
  })
})
