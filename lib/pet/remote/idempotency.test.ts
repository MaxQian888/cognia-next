import {
  __resetPetIdempotencyLedgerForTesting,
  createPetIdempotencyLedger,
  getPetIdempotencyLedger,
  ledgerKey,
} from "./idempotency"

describe("pet idempotency ledger", () => {
  it("runs an intent once and replays its answer to a retry", async () => {
    const ledger = createPetIdempotencyLedger({ now: () => 0 })
    const fn = jest.fn(async () => ({ ok: true }))
    const first = await ledger.run("phone", "k1", fn)
    const second = await ledger.run("phone", "k1", fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it("joins a retry that lands while the first attempt is still running", async () => {
    const ledger = createPetIdempotencyLedger({ now: () => 0 })
    let release!: (value: string) => void
    const fn = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )
    const a = ledger.run("phone", "k1", fn)
    const b = ledger.run("phone", "k1", fn)
    release("fed")
    await expect(Promise.all([a, b])).resolves.toEqual(["fed", "fed"])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("scopes keys to the authenticated device", async () => {
    const ledger = createPetIdempotencyLedger({ now: () => 0 })
    const fn = jest.fn(async () => 1)
    await ledger.run("phone-a", "same", fn)
    await ledger.run("phone-b", "same", fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(ledgerKey("phone-a", "same")).toBe("phone-a:same")
  })

  it("forgets an attempt that failed, so it can be retried", async () => {
    const ledger = createPetIdempotencyLedger({ now: () => 0 })
    const fn = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error("bridge dropped"))
      .mockResolvedValueOnce("fed")
    await expect(ledger.run("phone", "k1", fn)).rejects.toThrow("bridge dropped")
    await expect(ledger.run("phone", "k1", fn)).resolves.toBe("fed")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("expires an answer after the TTL", async () => {
    let now = 0
    const ledger = createPetIdempotencyLedger({ now: () => now, ttlMs: 1000 })
    const fn = jest.fn(async () => "x")
    await ledger.run("phone", "k1", fn)
    now = 999
    await ledger.run("phone", "k1", fn)
    expect(fn).toHaveBeenCalledTimes(1)
    now = 1000
    await ledger.run("phone", "k1", fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("evicts the oldest intent past the bound", async () => {
    const ledger = createPetIdempotencyLedger({ now: () => 0, maxEntries: 2 })
    const fn = jest.fn(async () => "x")
    await ledger.run("p", "a", fn)
    await ledger.run("p", "b", fn)
    await ledger.run("p", "c", fn)
    expect(ledger.size()).toBe(2)
    await ledger.run("p", "a", fn)
    expect(fn).toHaveBeenCalledTimes(4)
    ledger.clear()
    expect(ledger.size()).toBe(0)
  })

  it("shares one process-wide ledger until reset", () => {
    const a = getPetIdempotencyLedger()
    expect(getPetIdempotencyLedger()).toBe(a)
    __resetPetIdempotencyLedgerForTesting()
    expect(getPetIdempotencyLedger()).not.toBe(a)
  })
})
