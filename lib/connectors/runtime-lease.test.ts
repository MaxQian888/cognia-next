import {
  CONNECTOR_RUNTIME_LEASE_RENEW_MS,
  CONNECTOR_RUNTIME_LEASE_TTL_MS,
  createConnectorRuntimeLease,
  type ConnectorRuntimeLeaseOptions,
} from "./runtime-lease"

/** Captures the renew callback so tests advance the loop by hand. */
function timers() {
  let tick: (() => void) | undefined
  let cleared = 0
  const handle = 42 as unknown as ReturnType<typeof setInterval>
  return {
    fire: () => tick?.(),
    get cleared() {
      return cleared
    },
    setInterval: ((fn: () => void) => {
      tick = fn
      return handle
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      cleared += 1
    }) as unknown as typeof clearInterval,
  }
}

function makeOpts(overrides: Partial<ConnectorRuntimeLeaseOptions> = {}) {
  const logs: Array<[string, string]> = []
  const t = timers()
  const ports = {
    acquire: jest.fn(async () => true),
    renew: jest.fn(async () => true),
    release: jest.fn(async () => true),
  }
  const onLeaseLost = jest.fn()
  const onLeaseAcquired = jest.fn()
  const opts: ConnectorRuntimeLeaseOptions = {
    ownerClass: "desktop",
    ports,
    log: (level, message) => logs.push([level, message]),
    onLeaseLost,
    onLeaseAcquired,
    onUnavailable: "block",
    makeOwnerId: () => "fixed-id",
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
    ...overrides,
  }
  return { opts, ports, logs, onLeaseLost, onLeaseAcquired, timers: t }
}

describe("createConnectorRuntimeLease", () => {
  it("stamps the owner class into the id both hosts share", async () => {
    for (const ownerClass of ["desktop", "brain"] as const) {
      const { opts, ports } = makeOpts({ ownerClass })
      await createConnectorRuntimeLease(opts)(new AbortController().signal)
      // The Rust side reads priority off this prefix; a wrong one silently
      // demotes a brain to desktop priority.
      expect(ports.acquire).toHaveBeenCalledWith(
        `${ownerClass}:fixed-id`,
        CONNECTOR_RUNTIME_LEASE_TTL_MS
      )
    }
  })

  it("owns the runtime and renews on every interval tick", async () => {
    const { opts, ports, onLeaseAcquired, timers: t } = makeOpts()
    await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
      true
    )
    expect(onLeaseAcquired).toHaveBeenCalledTimes(1)
    expect(ports.renew).not.toHaveBeenCalled()

    const drain = async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
    }
    t.fire()
    await drain()
    t.fire()
    await drain()
    expect(ports.renew).toHaveBeenCalledTimes(2)
    expect(ports.renew).toHaveBeenLastCalledWith("desktop:fixed-id", CONNECTOR_RUNTIME_LEASE_TTL_MS)
  })

  it("stands down without booting when another runtime holds the lease", async () => {
    const ports = {
      acquire: jest.fn(async () => false),
      renew: jest.fn(async () => true),
      release: jest.fn(async () => true),
    }
    const { opts, logs, onLeaseAcquired } = makeOpts({ ports })
    await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
      false
    )
    expect(onLeaseAcquired).not.toHaveBeenCalled()
    // Never release a lease we do not hold — that would evict the real owner.
    expect(ports.release).not.toHaveBeenCalled()
    expect(logs.some(([, m]) => m.includes("Another runtime owns"))).toBe(true)
  })

  it("waits for an acknowledged desktop handoff before starting a brain runtime", async () => {
    let acknowledgeHandoff: (() => void) | undefined
    const ports = {
      acquire: jest.fn().mockResolvedValueOnce("handoff-pending").mockResolvedValueOnce("acquired"),
      renew: jest.fn(async () => true),
      release: jest.fn(async () => true),
    }
    const waitForHandoff = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledgeHandoff = resolve
        })
    )
    const { opts, onLeaseAcquired } = makeOpts({
      ownerClass: "brain",
      ports,
      waitForHandoff,
    })

    const acquiring = createConnectorRuntimeLease(opts)(new AbortController().signal)
    await Promise.resolve()
    await Promise.resolve()
    expect(onLeaseAcquired).not.toHaveBeenCalled()
    expect(ports.acquire).toHaveBeenCalledTimes(1)

    acknowledgeHandoff?.()
    await expect(acquiring).resolves.toBe(true)
    expect(ports.acquire).toHaveBeenCalledTimes(2)
    expect(onLeaseAcquired).toHaveBeenCalledTimes(1)
  })

  it("does not wait when a same-class owner is busy", async () => {
    const waitForHandoff = jest.fn(async () => undefined)
    const { opts, onLeaseAcquired } = makeOpts({
      ownerClass: "brain",
      ports: {
        acquire: jest.fn(async () => "busy" as const),
        renew: jest.fn(async () => true),
        release: jest.fn(async () => true),
      },
      waitForHandoff,
    })

    await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
      false
    )
    expect(waitForHandoff).not.toHaveBeenCalled()
    expect(onLeaseAcquired).not.toHaveBeenCalled()
  })

  it("cancels a reserved handoff when aborted while waiting", async () => {
    const controller = new AbortController()
    const ports = {
      acquire: jest.fn(async () => "handoff-pending" as const),
      renew: jest.fn(async () => true),
      release: jest.fn(async () => true),
    }
    const { opts, onLeaseAcquired } = makeOpts({
      ownerClass: "brain",
      ports,
      waitForHandoff: async () => {
        controller.abort()
      },
    })

    await expect(createConnectorRuntimeLease(opts)(controller.signal)).resolves.toBe(false)
    expect(ports.release).toHaveBeenCalledWith("brain:fixed-id")
    expect(onLeaseAcquired).not.toHaveBeenCalled()
  })

  it("cancels a handoff reserved by an acquire that raced cancellation", async () => {
    const controller = new AbortController()
    const ports = {
      acquire: jest.fn(async () => {
        controller.abort()
        return "handoff-pending" as const
      }),
      renew: jest.fn(async () => true),
      release: jest.fn(async () => true),
    }
    const { opts } = makeOpts({ ownerClass: "brain", ports })

    await expect(createConnectorRuntimeLease(opts)(controller.signal)).resolves.toBe(false)
    expect(ports.release).toHaveBeenCalledWith("brain:fixed-id")
  })

  it("cancels the reservation when a handoff retry fails", async () => {
    const ports = {
      acquire: jest
        .fn()
        .mockResolvedValueOnce("handoff-pending")
        .mockRejectedValueOnce(new Error("retry failed")),
      renew: jest.fn(async () => true),
      release: jest.fn(async () => true),
    }
    const { opts, logs } = makeOpts({
      ownerClass: "brain",
      ports,
      waitForHandoff: async () => undefined,
    })

    await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
      false
    )
    expect(ports.release).toHaveBeenCalledWith("brain:fixed-id")
    expect(
      logs.some(([level, message]) => level === "error" && message.includes("retry failed"))
    ).toBe(true)
  })

  it("tears down and reports when the lease is lost on renew", async () => {
    const { opts, ports, onLeaseLost, timers: t } = makeOpts()
    ports.renew.mockResolvedValueOnce(false)
    await createConnectorRuntimeLease(opts)(new AbortController().signal)

    t.fire()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    expect(ports.release).toHaveBeenCalledWith("desktop:fixed-id")
    expect(t.cleared).toBe(1)
  })

  it("stops connector transports before acknowledging a preempting owner", async () => {
    const order: string[] = []
    const {
      opts,
      ports,
      timers: t,
    } = makeOpts({
      onLeaseLost: () => {
        order.push("runtime-stopped")
      },
    })
    ports.renew.mockResolvedValueOnce(false)
    ports.release.mockImplementationOnce(async () => {
      order.push("lease-released")
      return true
    })
    await createConnectorRuntimeLease(opts)(new AbortController().signal)

    t.fire()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(order).toEqual(["runtime-stopped", "lease-released"])
  })

  it("awaits asynchronous transport teardown before releasing a lost lease", async () => {
    let finishTeardown: (() => void) | undefined
    const order: string[] = []
    const {
      opts,
      ports,
      timers: t,
    } = makeOpts({
      onLeaseLost: async () => {
        order.push("runtime-stop-started")
        await new Promise<void>((resolve) => {
          finishTeardown = resolve
        })
        order.push("runtime-stopped")
      },
    })
    ports.renew.mockResolvedValueOnce(false)
    ports.release.mockImplementationOnce(async () => {
      order.push("lease-released")
      return true
    })
    await createConnectorRuntimeLease(opts)(new AbortController().signal)

    t.fire()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(order).toEqual(["runtime-stop-started"])
    expect(ports.release).not.toHaveBeenCalled()

    finishTeardown?.()
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    expect(order).toEqual(["runtime-stop-started", "runtime-stopped", "lease-released"])
  })

  it("releases the lease when transport teardown rejects", async () => {
    const {
      opts,
      ports,
      logs,
      timers: t,
    } = makeOpts({
      onLeaseLost: async () => {
        throw new Error("stop failed")
      },
    })
    ports.renew.mockResolvedValueOnce(false)
    await createConnectorRuntimeLease(opts)(new AbortController().signal)

    t.fire()
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    expect(ports.release).toHaveBeenCalledWith("desktop:fixed-id")
    expect(
      logs.some(([level, message]) => level === "error" && message.includes("stop failed"))
    ).toBe(true)
  })

  it("treats a renewal error the same as a lost lease", async () => {
    const { opts, ports, onLeaseLost, logs, timers: t } = makeOpts()
    ports.renew.mockRejectedValueOnce(new Error("companion gone"))
    await createConnectorRuntimeLease(opts)(new AbortController().signal)

    t.fire()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    // A renew we cannot complete is indistinguishable from one that said no —
    // continuing would risk two runtimes answering the same message.
    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    expect(logs.some(([level, m]) => level === "error" && m.includes("companion gone"))).toBe(true)
  })

  it("blocks a brain when the lease is unreachable", async () => {
    const { opts, logs } = makeOpts({
      ownerClass: "brain",
      onUnavailable: "block",
      ports: {
        acquire: jest.fn(async () => {
          throw new Error("no companion")
        }),
        renew: jest.fn(async () => true),
        release: jest.fn(async () => true),
      } as never,
    })
    // A brain that cannot reach its companion would be an unarbitrated second
    // owner, which is exactly what this guard exists to prevent.
    await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
      false
    )
    expect(logs.some(([level]) => level === "error")).toBe(true)
  })

  it("lets the desktop proceed when the lease is unreachable", async () => {
    const { opts, logs, onLeaseAcquired } = makeOpts({
      onUnavailable: "proceed",
      ports: {
        acquire: jest.fn(async () => {
          throw new Error("command not found")
        }),
        renew: jest.fn(async () => true),
        release: jest.fn(async () => true),
      } as never,
    })
    // A stock desktop must keep booting exactly as it did before the guard
    // existed; the Web Lock still covers its own webviews.
    await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
      true
    )
    expect(logs.some(([level, m]) => level === "warn" && m.includes("without cross-process"))).toBe(
      true
    )
    // Nothing was acquired, so there is no owner-only work to install.
    expect(onLeaseAcquired).not.toHaveBeenCalled()
  })

  it("refuses immediately when the signal is already aborted", async () => {
    const { opts, ports } = makeOpts()
    const ac = new AbortController()
    ac.abort()
    await expect(createConnectorRuntimeLease(opts)(ac.signal)).resolves.toBe(false)
    expect(ports.acquire).not.toHaveBeenCalled()
  })

  it("hands the lease back when teardown races the grant", async () => {
    const ac = new AbortController()
    const racing = {
      acquire: jest.fn(async () => {
        ac.abort()
        return true
      }),
      renew: jest.fn(async () => true),
      release: jest.fn(async () => true),
    }
    const { opts } = makeOpts({ ports: racing })
    await expect(createConnectorRuntimeLease(opts)(ac.signal)).resolves.toBe(false)
    // Otherwise the slot stays held for a full TTL by a runtime that never ran.
    expect(racing.release).toHaveBeenCalledWith("desktop:fixed-id")
  })

  it("releases on abort and only once", async () => {
    const { opts, ports, timers: t } = makeOpts()
    const ac = new AbortController()
    await createConnectorRuntimeLease(opts)(ac.signal)
    ac.abort()
    ac.abort()
    expect(ports.release).toHaveBeenCalledTimes(1)
    expect(t.cleared).toBe(1)
  })

  it("warns rather than throwing when the release call fails", async () => {
    const { opts, ports, logs } = makeOpts()
    ports.release.mockRejectedValueOnce(new Error("companion gone"))
    const ac = new AbortController()
    await createConnectorRuntimeLease(opts)(ac.signal)
    ac.abort()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    // Teardown must not reject into an unhandled promise; the TTL reclaims
    // the slot anyway.
    expect(logs.some(([level, m]) => level === "warn" && m.includes("release failed"))).toBe(true)
  })

  it("renders non-Error rejections and works without an onLeaseAcquired hook", async () => {
    const ports = {
      acquire: jest.fn(async () => true),
      renew: jest.fn(async () => {
        throw "renew blew up"
      }),
      release: jest.fn(async () => {
        throw "release blew up"
      }),
    }
    const {
      opts,
      logs,
      onLeaseLost,
      timers: t,
    } = makeOpts({
      ports,
      onLeaseAcquired: undefined,
    })
    const ac = new AbortController()
    await expect(createConnectorRuntimeLease(opts)(ac.signal)).resolves.toBe(true)

    t.fire()
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(onLeaseLost).toHaveBeenCalledTimes(1)
    // Dexie and Tauri both reject with plain values in places; an operator
    // reading the log needs the value, not "[object Object]".
    expect(logs.some(([, m]) => m.includes("renew blew up"))).toBe(true)
    expect(logs.some(([, m]) => m.includes("release blew up"))).toBe(true)
  })

  it("reports a non-Error acquire rejection on both unavailability policies", async () => {
    for (const onUnavailable of ["block", "proceed"] as const) {
      const { opts, logs } = makeOpts({
        onUnavailable,
        ports: {
          acquire: jest.fn(async () => {
            throw "acquire blew up"
          }),
          renew: jest.fn(async () => true),
          release: jest.fn(async () => true),
        },
      })
      await expect(createConnectorRuntimeLease(opts)(new AbortController().signal)).resolves.toBe(
        onUnavailable === "proceed"
      )
      expect(logs.some(([, m]) => m.includes("acquire blew up"))).toBe(true)
    }
  })

  it("skips a renew while one is still in flight", async () => {
    let resolveRenew: ((value: boolean) => void) | undefined
    const { opts, ports, timers: t } = makeOpts()
    ports.renew.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRenew = resolve
        })
    )
    await createConnectorRuntimeLease(opts)(new AbortController().signal)
    t.fire()
    t.fire()
    // A slow companion must not stack renewals until one of them wins a race
    // and reports a phantom loss.
    expect(ports.renew).toHaveBeenCalledTimes(1)
    resolveRenew?.(true)
  })

  it("uses the real interval constants by default", async () => {
    const spy = jest.spyOn(globalThis, "setInterval")
    const { opts, ports } = makeOpts({ setInterval: undefined, clearInterval: undefined })
    const ac = new AbortController()
    await createConnectorRuntimeLease(opts)(ac.signal)
    expect(spy).toHaveBeenCalledWith(expect.any(Function), CONNECTOR_RUNTIME_LEASE_RENEW_MS)
    ac.abort()
    expect(ports.release).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("generates a random owner id when no seam is supplied", async () => {
    const { opts, ports } = makeOpts({ makeOwnerId: undefined })
    await createConnectorRuntimeLease(opts)(new AbortController().signal)
    const [ownerId] = ports.acquire.mock.calls[0] as unknown as [string, number]
    expect(ownerId).toMatch(/^desktop:[0-9a-f-]{36}$/)
  })
})
