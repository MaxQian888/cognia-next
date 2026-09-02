import {
  PROVIDER_OPERATION_GROUPS,
  PROVIDER_OPERATION_ID_PATTERN,
  PROVIDER_OPERATION_IDS,
  PROVIDER_OPERATION_SCOPES,
  PROVIDER_OPERATION_SURFACES,
  isProviderOperationId,
  type ProviderOperationCell,
  type ProviderOperationResult,
} from "./provider-operations"

describe("provider operation vocabulary", () => {
  it("has unique, well-formed ids", () => {
    expect(new Set(PROVIDER_OPERATION_IDS).size).toBe(PROVIDER_OPERATION_IDS.length)
    for (const id of PROVIDER_OPERATION_IDS) {
      expect(id).toMatch(PROVIDER_OPERATION_ID_PATTERN)
    }
    expect(PROVIDER_OPERATION_ID_PATTERN.test("models")).toBe(false)
    expect(PROVIDER_OPERATION_ID_PATTERN.test("Models.list")).toBe(false)
    expect(PROVIDER_OPERATION_ID_PATTERN.test("vector-stores.files.add")).toBe(true)
  })

  it("classifies ids with the frozen list", () => {
    expect(isProviderOperationId("language.generate")).toBe(true)
    expect(isProviderOperationId("language.summon")).toBe(false)
  })

  it("keeps the scope set at six and the surfaces at three", () => {
    expect(PROVIDER_OPERATION_SCOPES).toHaveLength(6)
    expect(PROVIDER_OPERATION_SURFACES).toEqual(["renderer", "sidecar", "rust-proxy"])
    expect(PROVIDER_OPERATION_GROUPS).toContain("files-jobs")
  })

  it("forces unknown cells to carry provenance, freshness, failure and retry", () => {
    // Type-level pin: an `unknown` without its evidence does not compile.
    const cell: ProviderOperationCell = {
      operationId: "models.list",
      support: "unknown",
      availability: "unavailable",
      provenance: "probe-failed",
      freshness: "stale",
      failure: { code: "network", retryable: true, message: "probe timed out" },
      retry: { on: "timer", afterMs: 60_000 },
    }
    expect(cell.support).toBe("unknown")
    const unsupported: ProviderOperationCell = {
      operationId: "files.upload",
      support: "unsupported",
      availability: "unavailable",
      reason: "no file API",
    }
    expect(unsupported.availability).toBe("unavailable")
  })

  it("results are a discriminated union on ok", () => {
    const failure: ProviderOperationResult = {
      ok: false,
      operationId: "balance.read",
      availability: "needs-auth",
      failure: { code: "authentication", retryable: false, message: "no key" },
    }
    expect(failure.ok).toBe(false)
  })
})
