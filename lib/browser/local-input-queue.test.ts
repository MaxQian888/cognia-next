import { createLocalInputQueue, type LocalBrowserInput } from "@/lib/browser/local-input-queue"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function mouse(type: string, extra: Record<string, unknown> = {}): LocalBrowserInput {
  return { kind: "mouse", payload: { type, x: 1, y: 2, ...extra } }
}

/** A dispatcher whose calls finish only when the test says so. */
function gatedDispatch() {
  const sent: LocalBrowserInput[] = []
  const gates: ReturnType<typeof deferred>[] = []
  const dispatch = jest.fn((input: LocalBrowserInput) => {
    sent.push(input)
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  })
  const release = async () => {
    gates.shift()?.resolve()
    await flush()
  }
  return { sent, dispatch, release }
}

describe("createLocalInputQueue", () => {
  it("sends events one at a time, in the order they happened", async () => {
    const { sent, dispatch, release } = gatedDispatch()
    const queue = createLocalInputQueue(dispatch)
    queue.send(mouse("mousePressed", { button: "left" }))
    queue.send(mouse("mouseReleased", { button: "left" }))
    queue.send({ kind: "key", payload: { type: "keyDown", key: "a" } })
    await flush()
    expect(sent.map((input) => input.payload.type)).toEqual(["mousePressed"])
    await release()
    expect(sent.map((input) => input.payload.type)).toEqual(["mousePressed", "mouseReleased"])
    await release()
    await release()
    expect(sent.map((input) => input.payload.type)).toEqual([
      "mousePressed",
      "mouseReleased",
      "keyDown",
    ])
  })

  it("keeps only the latest waiting pointer move", async () => {
    const { sent, dispatch, release } = gatedDispatch()
    const queue = createLocalInputQueue(dispatch)
    queue.send(mouse("mouseMoved", { x: 1 }))
    queue.send(mouse("mouseMoved", { x: 2 }))
    queue.send(mouse("mouseMoved", { x: 3 }))
    await release()
    await release()
    expect(sent.map((input) => input.payload.x)).toEqual([1, 3])
  })

  it("sums waiting wheel deltas into one scroll at the latest position", async () => {
    const { sent, dispatch, release } = gatedDispatch()
    const queue = createLocalInputQueue(dispatch)
    queue.send(mouse("mouseWheel", { deltaX: 0, deltaY: 10 }))
    queue.send(mouse("mouseWheel", { x: 5, deltaX: 2, deltaY: 30 }))
    queue.send(mouse("mouseWheel", { x: 6, deltaX: -1, deltaY: 40 }))
    await release()
    await release()
    expect(sent).toHaveLength(2)
    expect(sent[1].payload).toMatchObject({ type: "mouseWheel", x: 6, deltaX: 1, deltaY: 70 })
  })

  it("never merges across a press, a key or a modifier change", async () => {
    const { sent, dispatch, release } = gatedDispatch()
    const queue = createLocalInputQueue(dispatch)
    queue.send(mouse("mouseMoved", { x: 0 }))
    queue.send(mouse("mouseMoved", { x: 1 }))
    queue.send(mouse("mousePressed"))
    queue.send(mouse("mouseMoved", { x: 2 }))
    queue.send(mouse("mouseWheel", { deltaY: 10, modifiers: 0 }))
    queue.send(mouse("mouseWheel", { deltaY: 10, modifiers: 4 }))
    for (let index = 0; index < 6; index += 1) await release()
    expect(
      sent.map((input) => [input.payload.type, input.payload.x ?? input.payload.modifiers])
    ).toEqual([
      ["mouseMoved", 0],
      ["mouseMoved", 1],
      ["mousePressed", 1],
      ["mouseMoved", 2],
      ["mouseWheel", 1],
      ["mouseWheel", 1],
    ])
  })

  it("keeps going after a failed event", async () => {
    const dispatch = jest
      .fn<Promise<unknown>, [LocalBrowserInput]>()
      .mockRejectedValueOnce(new Error("dialog"))
      .mockResolvedValue(undefined)
    const queue = createLocalInputQueue(dispatch)
    queue.send(mouse("mousePressed"))
    queue.send(mouse("mouseReleased"))
    await flush()
    await flush()
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it("drops what is waiting once disposed", async () => {
    const { sent, dispatch, release } = gatedDispatch()
    const queue = createLocalInputQueue(dispatch)
    queue.send(mouse("mousePressed"))
    queue.send(mouse("mouseReleased"))
    queue.dispose()
    queue.send(mouse("mouseMoved"))
    await release()
    await release()
    expect(sent.map((input) => input.payload.type)).toEqual(["mousePressed"])
  })
})
