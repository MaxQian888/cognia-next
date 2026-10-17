import { createSharedInstall } from "./shared-install"

function harness(options: { unavailable?: boolean; fail?: boolean } = {}) {
  const live = new Set<number>()
  let next = 0
  const setUp = jest.fn(async () => {
    if (options.fail) throw new Error("listen failed")
    if (options.unavailable) return null
    const id = next++
    live.add(id)
    return () => {
      live.delete(id)
    }
  })
  return { live, setUp, install: createSharedInstall(setUp) }
}

describe("createSharedInstall", () => {
  it("keeps one listener through a StrictMode mount → cleanup → mount", async () => {
    const { live, setUp, install } = harness()
    // Effect #1 starts installing; its cleanup runs before the install
    // resolves, so it releases as soon as it gets its teardown.
    let cancelled = false
    const first = install().then((release) => {
      if (cancelled) release()
      return release
    })
    cancelled = true
    // Effect #2.
    const second = await install()
    await first
    expect(setUp).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
    second()
    await Promise.resolve()
    await Promise.resolve()
    expect(live.size).toBe(0)
  })

  it("shares one listener and tears it down with the last release", async () => {
    const { live, setUp, install } = harness()
    const a = await install()
    const b = await install()
    expect(setUp).toHaveBeenCalledTimes(1)
    a()
    a()
    await Promise.resolve()
    expect(live.size).toBe(1)
    b()
    await Promise.resolve()
    await Promise.resolve()
    expect(live.size).toBe(0)
    // A later install starts afresh.
    await install()
    expect(setUp).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(1)
  })

  it("starts a fresh listener on forceReinstall and keeps the old one for its owners", async () => {
    const { live, setUp, install } = harness()
    const old = await install()
    const fresh = await install({ forceReinstall: true })
    const joined = await install()
    expect(setUp).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(2)
    old()
    await Promise.resolve()
    await Promise.resolve()
    expect(live.size).toBe(1)
    joined()
    fresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(live.size).toBe(0)
  })

  it("shares nothing when the platform cannot listen, so a later install retries", async () => {
    const { setUp, install } = harness({ unavailable: true })
    const noop = await install()
    noop()
    await install()
    expect(setUp).toHaveBeenCalledTimes(2)
  })

  it("rethrows a failed set-up and lets the next install retry", async () => {
    const { setUp, install } = harness({ fail: true })
    await expect(install()).rejects.toThrow("listen failed")
    await expect(install()).rejects.toThrow("listen failed")
    expect(setUp).toHaveBeenCalledTimes(2)
  })

  it("forgets the shared listener on reset, so the next install starts afresh", async () => {
    const { setUp, install } = harness()
    await install()
    install.reset()
    await install()
    expect(setUp).toHaveBeenCalledTimes(2)
  })
})
