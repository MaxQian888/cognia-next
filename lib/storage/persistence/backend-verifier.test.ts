import { createStorageBackendDiagnostic as vectorDiagnostic } from "@cognia/vector/backend-readiness"
import { createStorageBackendDiagnostic } from "./backend-verifier"

test("keeps diagnostic fields at the host compatibility boundary", () => {
  expect(
    createStorageBackendDiagnostic(
      "probe-failed",
      "offline",
      "2026-10-04T00:00:00Z",
      { provider: "chroma" },
      "reachability"
    )
  ).toEqual({
    code: "probe-failed",
    message: "offline",
    at: "2026-10-04T00:00:00Z",
    details: { provider: "chroma" },
    stage: "reachability",
  })
})

test("shares the vector factory and defaults to the current timestamp", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-10-04T01:02:03Z"))
  try {
    expect(createStorageBackendDiagnostic).toBe(vectorDiagnostic)
    expect(createStorageBackendDiagnostic("probe", "failed").at).toBe("2026-10-04T01:02:03.000Z")
  } finally {
    jest.useRealTimers()
  }
})
