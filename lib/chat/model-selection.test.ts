import { persistModelSelection, waitForModelSelection } from "./model-selection"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe("model selection persistence barrier", () => {
  it("serializes rapid selections and waits for the latest choice and runtime reset", async () => {
    const first = deferred()
    const reset = deferred()
    const events: string[] = []
    const a = persistModelSelection("rapid", async () => {
      events.push("auto")
      await first.promise
    })
    const b = persistModelSelection("rapid", async () => {
      events.push("manual")
      await reset.promise
      events.push("reset")
    })
    let sent = false
    const send = waitForModelSelection("rapid").then(() => {
      sent = true
    })
    expect(events).toEqual(["auto"])
    first.resolve()
    await a
    expect(sent).toBe(false)
    reset.resolve()
    await Promise.all([b, send])
    expect(events).toEqual(["auto", "manual", "reset"])
    expect(sent).toBe(true)
  })

  it("includes a newer selection queued while a send is waiting", async () => {
    const first = deferred()
    const second = deferred()
    const a = persistModelSelection(null, () => first.promise)
    let sent = false
    const send = waitForModelSelection(null).then(() => {
      sent = true
    })
    const b = persistModelSelection(null, () => second.promise)
    first.resolve()
    await a
    expect(sent).toBe(false)
    second.resolve()
    await Promise.all([b, send])
    expect(sent).toBe(true)
  })

  it("refuses a waiting send on save failure and lets a later choice recover", async () => {
    const pending = deferred()
    const save = persistModelSelection("failure", () => pending.promise)
    const send = waitForModelSelection("failure")
    const rejection = expect(send).rejects.toThrow("write failed")
    pending.reject(new Error("write failed"))
    await expect(save).rejects.toThrow("write failed")
    await rejection
    await persistModelSelection("failure", async () => undefined)
    await expect(waitForModelSelection("failure")).resolves.toBeUndefined()
  })

  it("does not block another session", async () => {
    const pending = deferred()
    const save = persistModelSelection("other", () => pending.promise)
    await expect(waitForModelSelection("independent")).resolves.toBeUndefined()
    pending.resolve()
    await save
  })
})
