import { E2BSandboxPool } from "./sandbox-pool"

function sandbox(id: string) {
  return {
    id,
    exec: jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    close: jest.fn<Promise<void>, []>(async () => undefined),
  }
}

describe("E2BSandboxPool", () => {
  it("binds immutable runtime generations to an existing workspace handle", () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("vm-1")
    pool.addWorkspace("/remote/a", vm, "on")

    expect(pool.claim("runtime:a", "/remote/a", "session:a").sandbox).toBe(vm)
    expect(pool.forOwner("runtime:a").workspacePath).toBe("/remote/a")
    expect(pool.claim("runtime:b", "/remote/a", "session:a").sandbox).toBe(vm)
    expect(() => pool.claim("runtime:other", "/remote/a", "session:other")).toThrow(
      /owned by another runtime session/
    )
    expect(() => pool.claim("runtime:c", "/missing")).toThrow(/no live E2B workspace/)
  })

  it("keeps the sandbox alive until both the handle and final runtime owner release", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("vm-1")
    pool.addWorkspace("/remote/a", vm, "on")
    pool.claim("runtime:a", "/remote/a", "session:a")
    pool.claim("runtime:b", "/remote/a", "session:a")

    await pool.releaseOwner("runtime:a")
    expect(vm.close).not.toHaveBeenCalled()
    expect(pool.forOwner("runtime:b").sandbox).toBe(vm)

    await pool.releaseOwner("runtime:b")
    expect(vm.close).not.toHaveBeenCalled()

    await expect(pool.removeWorkspace("/remote/a")).resolves.toBe(true)
    expect(vm.close).toHaveBeenCalledTimes(1)
  })

  it("keeps different runtime refs isolated on different workspaces", () => {
    const pool = new E2BSandboxPool()
    const a = sandbox("vm-a")
    const b = sandbox("vm-b")
    pool.addWorkspace("/remote/a", a, "on")
    pool.addWorkspace("/remote/b", b, "off")

    expect(pool.claim("runtime:a", "/remote/a").sandbox).toBe(a)
    expect(pool.claim("runtime:b", "/remote/b").sandbox).toBe(b)
  })

  it("rejects duplicate handles and prevents one owner from rebinding", () => {
    const pool = new E2BSandboxPool()
    const a = sandbox("vm-a")
    const b = sandbox("vm-b")
    pool.addWorkspace("/remote/a", a, "on")
    pool.addWorkspace("/remote/b", b, "off")

    expect(() => pool.addWorkspace("/remote/a", sandbox("duplicate"), "on")).toThrow(
      /already tracks workspace/
    )
    expect(pool.claim("runtime:a", "/remote/a").sandbox).toBe(a)
    expect(pool.claim("runtime:a", "/remote/a").sandbox).toBe(a)
    expect(() => pool.claim("runtime:a", "/remote/b")).toThrow(/already bound/)
  })

  it("drains a released handle while existing runtime owners keep executing", async () => {
    const pool = new E2BSandboxPool()
    let finishClose: (() => void) | undefined
    const vm = sandbox("vm-a")
    vm.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        })
    )
    pool.addWorkspace("/remote/a", vm, "on")

    pool.claim("runtime:a", "/remote/a", "session:a")
    const removal = pool.removeWorkspace("/remote/a")
    await expect(removal).resolves.toBe(true)
    expect(() => pool.claim("runtime:b", "/remote/a", "session:a")).toThrow(/released/)
    expect(pool.forOwner("runtime:a").sandbox).toBe(vm)
    expect(vm.close).not.toHaveBeenCalled()

    const release = pool.releaseOwner("runtime:a")
    expect(() => pool.claim("runtime:c", "/remote/a")).toThrow(/released|closing/)
    finishClose?.()
    await expect(release).resolves.toBeUndefined()
    await expect(pool.removeWorkspace("/remote/a")).resolves.toBe(false)
    await expect(pool.releaseOwner("missing-owner")).resolves.toBeUndefined()
  })

  it("closes an already released handle exactly once when its final owner exits", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("vm-1")
    pool.addWorkspace("/remote/a", vm, "on")
    pool.claim("runtime:a", "/remote/a")
    await pool.removeWorkspace("/remote/a")

    await Promise.all([pool.releaseOwner("runtime:a"), pool.releaseOwner("runtime:a")])

    expect(vm.close).toHaveBeenCalledTimes(1)
    expect(pool.liveSandboxCount()).toBe(0)
    expect(() => pool.forOwner("runtime:a")).toThrow(/not bound/)
  })

  it("dispose closes every remaining workspace once", async () => {
    const pool = new E2BSandboxPool()
    const a = sandbox("vm-a")
    const b = sandbox("vm-b")
    pool.addWorkspace("/remote/a", a, "on")
    pool.addWorkspace("/remote/b", b, "off")

    await Promise.all([pool.dispose(), pool.dispose()])

    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).toHaveBeenCalledTimes(1)
  })

  it("retains final ownership when close fails so release can retry", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("vm-a")
    vm.close.mockRejectedValueOnce(new Error("provider unavailable"))
    pool.addWorkspace("/remote/a", vm, "on")
    pool.claim("runtime:a", "/remote/a")
    await pool.removeWorkspace("/remote/a")

    await expect(pool.releaseOwner("runtime:a")).rejects.toThrow(/provider unavailable/)
    expect(pool.liveSandboxCount()).toBe(1)
    expect(pool.forOwner("runtime:a").sandbox).toBe(vm)

    await pool.releaseOwner("runtime:a")
    expect(vm.close).toHaveBeenCalledTimes(2)
    expect(pool.liveSandboxCount()).toBe(0)
  })

  it("forWorkspace rejects a handle that is released or mid-close", async () => {
    const pool = new E2BSandboxPool()
    let finishClose: (() => void) | undefined
    const vm = sandbox("vm-a")
    vm.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        })
    )
    pool.addWorkspace("/remote/a", vm, "on")
    pool.claim("runtime:a", "/remote/a")
    await pool.removeWorkspace("/remote/a")
    expect(() => pool.forWorkspace("/remote/a")).toThrow(/released/)

    // A `closing` entry that is NOT released comes from pool-level disposal —
    // `releaseOwner` on a released workspace reports "released" first. Let the
    // released workspace's close resolve so disposal can finish.
    vm.close.mockResolvedValue(undefined)
    const other = sandbox("vm-b")
    other.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve
        })
    )
    pool.addWorkspace("/remote/b", other, "off")
    const disposal = pool.dispose()
    expect(() => pool.forWorkspace("/remote/b")).toThrow(/closing/)
    finishClose?.()
    await disposal
    expect(() => pool.forWorkspace("/remote/b")).toThrow(/no live sandbox/)
  })

  it("publishes immutable snapshots of every live workspace", () => {
    const pool = new E2BSandboxPool()
    const a = sandbox("vm-a")
    pool.addWorkspace("/remote/a", a, "on")
    pool.addWorkspace("/remote/b", sandbox("vm-b"), "off")
    pool.claim("runtime:a", "/remote/a", "session:1")
    pool.claim("runtime:b", "/remote/a", "session:1")

    const rows = pool.snapshot()
    expect(rows).toHaveLength(2)
    const rowA = rows.find((row) => row.workspacePath === "/remote/a")
    expect(rowA).toMatchObject({
      sandboxId: "vm-a",
      network: "on",
      ownerGroup: "session:1",
      ownerRefs: ["runtime:a", "runtime:b"],
      handleReleased: false,
      closing: false,
    })
    expect(rows.find((row) => row.workspacePath === "/remote/b")).toMatchObject({
      sandboxId: "vm-b",
      network: "off",
      ownerRefs: [],
    })
    // Snapshot arrays are detached — mutating one must not corrupt the pool.
    rowA?.ownerRefs.push("injected")
    expect(
      pool.snapshot().find((row) => row.workspacePath === "/remote/a")?.ownerRefs
    ).toHaveLength(2)
  })

  it("notifies subscribers and bumps the version on every mutation", async () => {
    const pool = new E2BSandboxPool()
    const calls: number[] = []
    const unsubscribe = pool.subscribe(() => calls.push(pool.getVersion()))

    expect(pool.getVersion()).toBe(0)
    pool.addWorkspace("/remote/a", sandbox("vm-a"), "on")
    pool.claim("runtime:a", "/remote/a")
    await pool.removeWorkspace("/remote/a") // released, then closed (no owners left at release? has owner → stays)
    await pool.releaseOwner("runtime:a") // closes

    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect(pool.getVersion()).toBe(calls[calls.length - 1])
    expect(calls).toEqual([...calls].sort((x, y) => x - y)) // strictly monotonic

    unsubscribe()
    pool.addWorkspace("/remote/b", sandbox("vm-b"), "off")
    const after = calls.length
    pool.claim("runtime:b", "/remote/b")
    expect(calls).toHaveLength(after) // unsubscribed listeners go quiet
  })

  it("never lets a throwing subscriber break a mutation", () => {
    const pool = new E2BSandboxPool()
    pool.subscribe(() => {
      throw new Error("panel exploded")
    })
    expect(() => pool.addWorkspace("/remote/a", sandbox("vm-a"), "on")).not.toThrow()
    expect(pool.liveSandboxCount()).toBe(1)
  })

  it("dispose reports every close failure as an AggregateError, not just the first", async () => {
    const pool = new E2BSandboxPool()
    const a = sandbox("vm-a")
    const b = sandbox("vm-b")
    a.close.mockRejectedValue(new Error("a down"))
    b.close.mockRejectedValue(new Error("b down"))
    pool.addWorkspace("/remote/a", a, "on")
    pool.addWorkspace("/remote/b", b, "off")

    const failure = await pool.dispose().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    // Both closes were attempted — a rejected first close must not skip the rest.
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).toHaveBeenCalledTimes(1)
    // Failed entries stay tracked so a later dispose can retry them.
    expect(pool.liveSandboxCount()).toBe(2)
  })

  it("dispose surfaces a single close failure verbatim (no AggregateError wrapper)", async () => {
    const pool = new E2BSandboxPool()
    const a = sandbox("vm-a")
    a.close.mockRejectedValue(new Error("solo failure"))
    pool.addWorkspace("/remote/a", a, "on")

    await expect(pool.dispose()).rejects.toThrow("solo failure")
  })
})
