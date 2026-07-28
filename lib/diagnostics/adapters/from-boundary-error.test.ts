import { DIAGNOSTIC_CODES } from "@cognia/diagnostics"
import type { ErrorCategory, RecoveryKind } from "@/lib/error/classify-error"

import { BOUNDARY_CATEGORY_TO_CODE, diagnoseBoundaryError } from "./from-boundary-error"

const ALL_CATEGORIES: ErrorCategory[] = ["chunk-load", "network", "offline", "render", "unknown"]
const ALL_RECOVERIES: RecoveryKind[] = ["reload", "retry-online", "reset"]

describe("BOUNDARY_CATEGORY_TO_CODE", () => {
  it("maps every boundary category onto a known code", () => {
    expect(Object.keys(BOUNDARY_CATEGORY_TO_CODE).sort()).toEqual([...ALL_CATEGORIES].sort())
    for (const code of Object.values(BOUNDARY_CATEGORY_TO_CODE)) {
      expect(DIAGNOSTIC_CODES[code]).toBeDefined()
    }
  })
})

describe("diagnoseBoundaryError", () => {
  it("turns a stale chunk into a reload, not a boundary reset", () => {
    // A reset just re-imports the missing chunk and throws again; only a full
    // reload re-fetches the manifest.
    expect(diagnoseBoundaryError({ category: "chunk-load", recoveryKind: "reload" })).toEqual({
      code: "chunkLoad",
      actions: [{ kind: "reload-app" }],
    })
  })

  it("turns an offline boundary into a wait-for-connectivity retry", () => {
    expect(diagnoseBoundaryError({ category: "offline", recoveryKind: "retry-online" })).toEqual({
      code: "offline",
      actions: [{ kind: "retry-when-online" }],
    })
  })

  it("turns a render crash into a boundary reset", () => {
    expect(diagnoseBoundaryError({ category: "render", recoveryKind: "reset" })).toEqual({
      code: "renderCrash",
      actions: [{ kind: "reset-boundary" }],
    })
  })

  it("produces exactly one action for every recovery kind", () => {
    for (const recoveryKind of ALL_RECOVERIES) {
      const out = diagnoseBoundaryError({ category: "unknown", recoveryKind })
      expect(out.actions).toHaveLength(1)
    }
  })
})
