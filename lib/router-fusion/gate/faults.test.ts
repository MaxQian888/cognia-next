import {
  RouterFusionInfrastructureError,
  RouterFusionRefusalError,
  RouterFusionUnavailableError,
  isRefusal,
  toInfrastructureFault,
} from "./faults"

function named(name: string, message = name): Error {
  const error = new Error(message)
  error.name = name
  return error
}

describe("router-fusion fault classification", () => {
  it("[ACC:ISO-04] never treats a refusal as an infrastructure fault", () => {
    const refusal = new RouterFusionRefusalError("RUN_BUDGET_EXHAUSTED", "over budget")
    expect(toInfrastructureFault(refusal)).toBeNull()
    expect(isRefusal(refusal)).toBe(true)
  })

  it("maps store failures to db_unavailable and transaction failures to db_transaction", () => {
    expect(toInfrastructureFault(named("OpenFailedError"))?.code).toBe("db_unavailable")
    expect(toInfrastructureFault(named("DatabaseClosedError"))?.code).toBe("db_unavailable")
    expect(toInfrastructureFault(named("QuotaExceededError"))?.code).toBe("db_unavailable")
    expect(toInfrastructureFault(named("AbortError"))?.code).toBe("db_transaction")
    expect(toInfrastructureFault(named("PrematureCommitError"))?.code).toBe("db_transaction")
  })

  it("treats any other exception as an internal fault, keeping the cause", () => {
    const boom = new TypeError("undefined is not a function")
    const fault = toInfrastructureFault(boom)
    expect(fault?.code).toBe("internal")
    expect(fault?.cause).toBe(boom)
    expect(toInfrastructureFault("string thrown")?.message).toBe("string thrown")
  })

  it("passes through already-classified faults and unwraps unavailability", () => {
    const fault = new RouterFusionInfrastructureError("import_failed", "chunk load failed")
    expect(toInfrastructureFault(fault)).toBe(fault)
    const unavailable = new RouterFusionUnavailableError(fault)
    expect(unavailable.code).toBe("ROUTER_FUSION_UNAVAILABLE")
    expect(unavailable.message).toContain("import_failed")
    expect(toInfrastructureFault(unavailable)).toBe(fault)
  })
})
