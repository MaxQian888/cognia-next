/**
 * @jest-environment jsdom
 */

import {
  registerPushNotifications,
  reportPushTokenToDesktop,
  subscribeToPushNotifications,
  type PushPermission,
} from "./push-notifications"

interface FakePluginOpts {
  initialPerm?: PushPermission
  postRequestPerm?: PushPermission
  /** Token to emit on register(); null = emit registrationError. */
  token?: string | null
  /** When non-null, emit after Nms instead of synchronously. */
  emitDelayMs?: number
  /** Throw from check/requestPermissions. */
  permThrows?: Error
}

function makePlugin(opts: FakePluginOpts = {}) {
  let perm: PushPermission = opts.initialPerm ?? "prompt"
  const listeners: Record<string, Array<(payload: unknown) => void>> = {}
  const removers: Array<() => Promise<void>> = []

  const addListener = jest.fn(async (event: string, handler: (payload: unknown) => void) => {
    listeners[event] ??= []
    listeners[event].push(handler)
    const remover = jest.fn(async () => {
      listeners[event] = listeners[event].filter((h) => h !== handler)
    })
    removers.push(remover)
    return { remove: remover }
  })

  const register = jest.fn(async () => {
    const fire = () => {
      if (opts.token === null) {
        listeners["registrationError"]?.forEach((h) =>
          h({ error: "APNs registration failed" } as unknown)
        )
      } else if (opts.token !== undefined) {
        listeners["registration"]?.forEach((h) => h({ value: opts.token! } as unknown))
      } else {
        listeners["registration"]?.forEach((h) => h({ value: "default-token" } as unknown))
      }
    }
    if (opts.emitDelayMs && opts.emitDelayMs > 0) {
      setTimeout(fire, opts.emitDelayMs)
    } else {
      fire()
    }
  })

  return {
    listeners,
    removers,
    register,
    plugin: {
      checkPermissions: jest.fn(async () => {
        if (opts.permThrows) throw opts.permThrows
        return { receive: perm }
      }),
      requestPermissions: jest.fn(async () => {
        if (opts.permThrows) throw opts.permThrows
        perm = opts.postRequestPerm ?? "granted"
        return { receive: perm }
      }),
      register,
      addListener,
    },
  }
}

describe("registerPushNotifications", () => {
  it("returns registered + token on a happy path", async () => {
    const fake = makePlugin({ initialPerm: "granted", token: "abc-123" })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out).toEqual({ kind: "registered", token: "abc-123", platform: "unknown" })
  })

  it("requests permission when initially in prompt state", async () => {
    const fake = makePlugin({
      initialPerm: "prompt",
      postRequestPerm: "granted",
      token: "tok",
    })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out.kind).toBe("registered")
    expect(fake.plugin.requestPermissions).toHaveBeenCalled()
  })

  it("returns permission_denied when the user declines", async () => {
    const fake = makePlugin({ initialPerm: "prompt", postRequestPerm: "denied" })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out.kind).toBe("permission_denied")
    expect(fake.plugin.register).not.toHaveBeenCalled()
  })

  it("returns unsupported when the loader rejects (web build)", async () => {
    const out = await registerPushNotifications({
      loader: async () => {
        throw new Error("module not found")
      },
    })
    expect(out.kind).toBe("unsupported")
  })

  it("returns registration_failed when registrationError fires", async () => {
    const fake = makePlugin({ initialPerm: "granted", token: null })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out.kind).toBe("registration_failed")
    if (out.kind !== "registration_failed") return
    expect(out.message).toContain("APNs")
  })

  it("returns registration_failed when permission lookup throws", async () => {
    const fake = makePlugin({ permThrows: new Error("kaboom") })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out.kind).toBe("registration_failed")
  })

  it("returns registration_failed when no token arrives within the timeout", async () => {
    const fake = makePlugin({ initialPerm: "granted" })
    // Override register so it never fires the listener — let the timeout win.
    fake.register.mockImplementation(async () => {})
    const out = await registerPushNotifications({
      loader: async () => fake.plugin,
      timeoutMs: 50,
    })
    expect(out.kind).toBe("registration_failed")
    if (out.kind !== "registration_failed") return
    expect(out.message).toContain("did not return a token")
  })
})

describe("reportPushTokenToDesktop", () => {
  it("calls _rpc/register_push_token via the transport", async () => {
    const transport = {
      call: jest.fn().mockResolvedValue({}),
      subscribe: jest.fn(() => () => {}),
    }
    const out = await reportPushTokenToDesktop("tok", "ios", transport)
    expect(out).toEqual({ ok: true })
    expect(transport.call).toHaveBeenCalledWith("register_push_token", {
      token: "tok",
      platform: "ios",
    })
  })

  it("returns ok:false with the error message when transport.call rejects", async () => {
    const transport = {
      call: jest.fn().mockRejectedValue(new Error("not implemented")),
      subscribe: jest.fn(() => () => {}),
    }
    const out = await reportPushTokenToDesktop("tok", "android", transport)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("not implemented")
  })
})

describe("subscribeToPushNotifications", () => {
  it("invokes the handler on pushNotificationReceived", async () => {
    const fake = makePlugin({ initialPerm: "granted" })
    const handler = jest.fn()
    const teardown = await subscribeToPushNotifications(handler, {
      loader: async () => fake.plugin,
    })

    fake.listeners["pushNotificationReceived"]?.forEach((h) =>
      h({ title: "hi", body: "world", data: { foo: 1 } } as unknown)
    )

    expect(handler).toHaveBeenCalledWith({
      title: "hi",
      body: "world",
      data: { foo: 1 },
      foreground: true,
    })

    await teardown()
  })

  it("invokes the handler on pushNotificationActionPerformed (foreground=false)", async () => {
    const fake = makePlugin({ initialPerm: "granted" })
    const handler = jest.fn()
    await subscribeToPushNotifications(handler, { loader: async () => fake.plugin })

    fake.listeners["pushNotificationActionPerformed"]?.forEach((h) =>
      h({
        notification: { title: "alert", body: "open me" },
        actionId: "tap",
      } as unknown)
    )

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "alert",
        body: "open me",
        foreground: false,
      })
    )
  })

  it("returns a no-op teardown when the loader rejects (web)", async () => {
    const handler = jest.fn()
    const teardown = await subscribeToPushNotifications(handler, {
      loader: async () => {
        throw new Error("nope")
      },
    })
    await expect(teardown()).resolves.toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })
})
