import { FlushCoalescer } from "./flush-coalescer"

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe("FlushCoalescer", () => {
  it("runs immediately when idle", async () => {
    const runs: number[] = []
    const c = new FlushCoalescer<number>(async (n) => {
      runs.push(n)
    })
    await c.schedule(1)
    expect(runs).toEqual([1])
  })

  it("coalesces a burst into a single follow-up run", async () => {
    const runs: number[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const c = new FlushCoalescer<number>(async (n) => {
      runs.push(n)
      if (n === 1) await gate // hold the first run open
    })
    // Start run 1 (held), then schedule 2,3,4 while it is in flight.
    const first = c.schedule(1)
    await tick()
    void c.schedule(2)
    void c.schedule(3)
    void c.schedule(4)
    release()
    await first
    await tick()
    await tick()
    // Run 1 plus exactly one coalesced follow-up — NOT one per schedule.
    expect(runs).toEqual([1, 4])
  })

  it("applies merge to the coalesced payload (last status, OR'd force, frozen base)", async () => {
    type P = { status: string; now: number; force: boolean }
    const runs: P[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const c = new FlushCoalescer<P>(
      async (p) => {
        runs.push(p)
        if (p.status === "a") await gate
      },
      (prev, next) => ({
        status: next.status,
        now: prev ? prev.now : next.now,
        force: (prev?.force ?? false) || next.force,
      })
    )
    const first = c.schedule({ status: "a", now: 100, force: false })
    await tick()
    void c.schedule({ status: "b", now: 200, force: true })
    void c.schedule({ status: "c", now: 300, force: false })
    release()
    await first
    await tick()
    await tick()
    // base `now` frozen at the running run's 100; status = last (c); force OR'd true.
    expect(runs[1]).toEqual({ status: "c", now: 100, force: true })
  })

  it("reports busy while a run is in flight", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const c = new FlushCoalescer<void>(async () => {
      await gate
    })
    const p = c.schedule()
    expect(c.busy).toBe(true)
    release()
    await p
    expect(c.busy).toBe(false)
  })

  it("supports a void payload with the default merge", async () => {
    let count = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const c = new FlushCoalescer<void>(async () => {
      count++
      if (count === 1) await gate
    })
    const first = c.schedule()
    await tick()
    void c.schedule()
    void c.schedule()
    release()
    await first
    await tick()
    await tick()
    expect(count).toBe(2)
  })
})
