import { createFilesIdempotencyLedger } from "./idempotency"

describe("files idempotency ledger", () => {
  it("answers a retried intent from its first run, per device", async () => {
    const ledger = createFilesIdempotencyLedger()
    const run = jest.fn(async () => ({ key: "upload:a" }))
    const first = await ledger.run("phone-1", "files_library_duplicate:k1", run)
    const retry = await ledger.run("phone-1", "files_library_duplicate:k1", run)
    expect(retry).toBe(first)
    expect(run).toHaveBeenCalledTimes(1)
    // Another device with the same key is another intent.
    await ledger.run("phone-2", "files_library_duplicate:k1", run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("forgets a failed attempt so the same key can be retried", async () => {
    const ledger = createFilesIdempotencyLedger()
    const failing = jest.fn(async () => {
      throw new Error("transient")
    })
    await expect(ledger.run("phone-1", "k", failing)).rejects.toThrow("transient")
    const ok = jest.fn(async () => "done")
    await expect(ledger.run("phone-1", "k", ok)).resolves.toBe("done")
  })

  it("lets an answer go after its time to live", async () => {
    let now = 0
    const ledger = createFilesIdempotencyLedger({ now: () => now, ttlMs: 10 })
    const run = jest.fn(async () => now)
    await ledger.run("phone-1", "k", run)
    now = 11
    await ledger.run("phone-1", "k", run)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
