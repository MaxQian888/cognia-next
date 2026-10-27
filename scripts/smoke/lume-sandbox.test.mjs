import { test } from "node:test"
import assert from "node:assert/strict"
import { validateDiagnostics } from "./lume-sandbox.mjs"

test("native smoke refuses incompatible contracts and incomplete readiness receipts", () => {
  const diagnostics = { contractVersion: 1, lumeVersion: "0.6.1", enabled: false, resources: [] }
  validateDiagnostics(diagnostics)
  assert.throws(() => validateDiagnostics({ ...diagnostics, contractVersion: 2 }))
  assert.throws(() =>
    validateDiagnostics({
      ...diagnostics,
      resources: [
        {
          resourceId: "r",
          generation: 1,
          bootEpoch: "b",
          connectionId: "c",
          readiness: { vm: true },
        },
      ],
    })
  )
})
