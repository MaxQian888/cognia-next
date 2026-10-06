import {
  clearStorageBackendReadiness,
  createStorageBackendDiagnostic,
  getStorageBackendReadiness,
  getStorageBackendsByCategory,
  listStorageBackendReadiness,
  updateStorageBackendReadiness,
} from "./backend-readiness"

beforeEach(clearStorageBackendReadiness)

test("preserves readiness metadata and diagnostic merge semantics", () => {
  const diagnostic = createStorageBackendDiagnostic(
    "network",
    "offline",
    "2026-10-04T00:00:00Z",
    { attempt: 1 },
    "reachability"
  )
  updateStorageBackendReadiness({
    id: "vector-chroma",
    state: "configured",
    diagnostic,
    metadata: { source: "probe" },
  })
  const result = updateStorageBackendReadiness({ id: "vector-chroma", state: "reachable" })
  expect(result).toMatchObject({
    label: "Chroma",
    category: "vector-provider",
    state: "reachable",
    diagnostic,
    metadata: { source: "probe" },
  })
  expect(getStorageBackendReadiness("vector-chroma")).toBe(result)
  expect(listStorageBackendReadiness()).toEqual([result])
  expect(getStorageBackendsByCategory("vector-provider")).toEqual([result])
  clearStorageBackendReadiness()
  expect(listStorageBackendReadiness()).toEqual([])
})
