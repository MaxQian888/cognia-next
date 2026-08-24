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

  it("keeps a shared generation alive until its final owner releases", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("vm-1")
    pool.addWorkspace("/remote/a", vm, "on")
    pool.claim("runtime:a", "/remote/a", "session:a")
    pool.claim("runtime:b", "/remote/a", "session:a")

    await pool.releaseOwner("runtime:a")
    expect(vm.close).not.toHaveBeenCalled()
    expect(pool.forOwner("runtime:b").sandbox).toBe(vm)

    await pool.releaseOwner("runtime:b")
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

  it("reports remove results and rejects claims while a workspace closes", async () => {
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

    const removal = pool.removeWorkspace("/remote/a")
    expect(() => pool.claim("runtime:a", "/remote/a")).toThrow(/is closing/)
    finishClose?.()
    await expect(removal).resolves.toBe(true)
    await expect(pool.removeWorkspace("/remote/a")).resolves.toBe(false)
    await expect(pool.releaseOwner("missing-owner")).resolves.toBeUndefined()
  })

  it("release closes and forgets an owned sandbox exactly once", async () => {
    const pool = new E2BSandboxPool()
    const vm = sandbox("vm-1")
    pool.addWorkspace("/remote/a", vm, "on")
    pool.claim("runtime:a", "/remote/a")

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

    await expect(pool.releaseOwner("runtime:a")).rejects.toThrow(/provider unavailable/)
    expect(pool.liveSandboxCount()).toBe(1)
    expect(pool.forOwner("runtime:a").sandbox).toBe(vm)

    await pool.releaseOwner("runtime:a")
    expect(vm.close).toHaveBeenCalledTimes(2)
    expect(pool.liveSandboxCount()).toBe(0)
  })
})
