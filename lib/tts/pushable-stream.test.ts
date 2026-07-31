import { createPushableStream } from "./pushable-stream"

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe("createPushableStream", () => {
  it("delivers values pushed before iteration, in order", async () => {
    const p = createPushableStream()
    p.push("a")
    p.push("b")
    p.push("c")
    p.close()
    expect(await collect(p.stream)).toEqual(["a", "b", "c"])
  })

  it("resolves a pending pull when a value arrives later", async () => {
    const p = createPushableStream()
    const it = p.stream[Symbol.asyncIterator]()
    const nextP = it.next() // pull before any push → pends
    p.push("late")
    await expect(nextP).resolves.toEqual({ value: "late", done: false })
  })

  it("closing resolves a pending pull as done", async () => {
    const p = createPushableStream()
    const it = p.stream[Symbol.asyncIterator]()
    const nextP = it.next()
    p.close()
    await expect(nextP).resolves.toEqual({ value: undefined, done: true })
  })

  it("ignores pushes after close", async () => {
    const p = createPushableStream()
    p.push("kept")
    p.close()
    p.push("dropped")
    expect(await collect(p.stream)).toEqual(["kept"])
  })

  it("interleaves buffered and awaited values", async () => {
    const p = createPushableStream()
    const it = p.stream[Symbol.asyncIterator]()
    p.push("one")
    await expect(it.next()).resolves.toEqual({ value: "one", done: false })
    const pendingTwo = it.next()
    p.push("two")
    await expect(pendingTwo).resolves.toEqual({ value: "two", done: false })
    p.close()
    await expect(it.next()).resolves.toEqual({ value: undefined, done: true })
  })
})
