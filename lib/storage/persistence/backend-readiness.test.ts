import * as host from "./backend-readiness"
import * as vector from "@cognia/vector/backend-readiness"
import { createStorageBackendDiagnostic } from "./backend-verifier"
import type { StorageBackendReadinessRecord } from "./types"

test("host compatibility exports read the same vector registry", () => {
  vector.clearStorageBackendReadiness()
  const record: StorageBackendReadinessRecord = vector.updateStorageBackendReadiness({
    id: "vector-chroma",
    state: "operational",
  })
  expect(host.getStorageBackendReadiness("vector-chroma")).toBe(record)
  expect(createStorageBackendDiagnostic).toBe(vector.createStorageBackendDiagnostic)
  host.clearStorageBackendReadiness()
  expect(vector.listStorageBackendReadiness()).toEqual([])
})
