import {
  DEFAULT_ACCOUNT_NAMESPACE,
  deriveCursorNamespace,
  hostKeyOf,
  hostRecordKey,
  initialConnectionState,
  sameHost,
  StaleConnectionGenerationError,
  type CompanionHostRecord,
} from "./types"

describe("deriveCursorNamespace", () => {
  it("encodes both halves so neither can forge the other's boundary", () => {
    const collidingA = deriveCursorNamespace({ accountNamespace: "a:b", hostId: "c" })
    const collidingB = deriveCursorNamespace({ accountNamespace: "a", hostId: "b:c" })
    expect(collidingA).not.toBe(collidingB)
  })

  it("is stable for the same key", () => {
    const key = { accountNamespace: "acct_1", hostId: "host_1" }
    expect(deriveCursorNamespace(key)).toBe(deriveCursorNamespace({ ...key }))
  })

  it("separates the same host paired from two accounts", () => {
    expect(deriveCursorNamespace({ accountNamespace: "a", hostId: "h" })).not.toBe(
      deriveCursorNamespace({ accountNamespace: "b", hostId: "h" })
    )
  })

  it("is what hostRecordKey uses, so records and namespaces cannot diverge", () => {
    const key = { accountNamespace: "acct_1", hostId: "host_1" }
    expect(hostRecordKey(key)).toBe(deriveCursorNamespace(key))
  })
})

describe("sameHost / hostKeyOf", () => {
  const record = {
    hostId: "h1",
    accountNamespace: "a1",
  } as CompanionHostRecord

  it("requires both halves to match", () => {
    expect(sameHost({ hostId: "h1", accountNamespace: "a1" }, hostKeyOf(record))).toBe(true)
    expect(sameHost({ hostId: "h1", accountNamespace: "a2" }, hostKeyOf(record))).toBe(false)
    expect(sameHost({ hostId: "h2", accountNamespace: "a1" }, hostKeyOf(record))).toBe(false)
  })
})

describe("initialConnectionState", () => {
  it("starts unknown at generation zero", () => {
    expect(initialConnectionState()).toEqual({
      status: "unknown",
      generation: 0,
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
    })
  })

  it("returns a fresh object each time", () => {
    expect(initialConnectionState()).not.toBe(initialConnectionState())
  })
})

describe("StaleConnectionGenerationError", () => {
  it("carries both generations and names itself", () => {
    const error = new StaleConnectionGenerationError(2, 5)
    expect(error.name).toBe("StaleConnectionGenerationError")
    expect(error.expected).toBe(2)
    expect(error.actual).toBe(5)
    expect(error.message).toContain("generation 2")
    expect(error.message).toContain("at 5")
  })
})

describe("DEFAULT_ACCOUNT_NAMESPACE", () => {
  it("is a reserved value no real account id can collide with", () => {
    // Account ids are `acct_…`; the sentinel is deliberately outside that shape.
    expect(DEFAULT_ACCOUNT_NAMESPACE).toBe("__local__")
    expect(DEFAULT_ACCOUNT_NAMESPACE.startsWith("acct_")).toBe(false)
  })
})
