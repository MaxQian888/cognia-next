/**
 * @jest-environment jsdom
 */

import {
  registerPushNotifications,
  reportPushTokenToDesktop,
  subscribeToPushNotifications,
  subscribeToPushTokenChanges,
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
  permThrows?: unknown
  registrationError?: string
}

function makePlugin(opts: FakePluginOpts = {}) {
  let perm: PushPermission = opts.initialPerm ?? "prompt"
  const listeners: Record<string, Array<(payload: unknown) => void>> = {}
  const removers: Array<jest.Mock<Promise<void>, []>> = []

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
          h({ error: opts.registrationError ?? "APNs registration failed" } as unknown)
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

/**
 * `window.Capacitor` is injected by the mobile boot, so the DOM lib knows
 * nothing about it. One typed view of the global instead of a cast at each of
 * the six access sites; the value is only ever stashed and restored here, never
 * read through, so `unknown` is enough.
 */
const capacitorWindow = window as Window & typeof globalThis & { Capacitor?: unknown }

describe("registerPushNotifications", () => {
  it.each([0, 1])(
    "uses configured Huawei push with Google service status %s and keeps the provider explicit",
    async (googleStatus) => {
      const hms = makePlugin({ initialPerm: "granted", token: "huawei-token" })
      const fcm = makePlugin({ initialPerm: "granted" })
      const previous = capacitorWindow.Capacitor
      capacitorWindow.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => "android",
        Plugins: {
          CogniaDeviceServices: { getStatus: async () => ({ status: googleStatus }) },
          CogniaHuaweiPush: {
            ...hms.plugin,
            getStatus: async () => ({ configured: true, available: true, status: 0 }),
          },
          PushNotifications: fcm.plugin,
        },
      }
      try {
        await expect(registerPushNotifications({ requestPermission: false })).resolves.toEqual({
          kind: "registered",
          token: "huawei-token",
          platform: "android",
          provider: "hms",
        })
        expect(fcm.register).not.toHaveBeenCalled()
        expect(hms.plugin.requestPermissions).not.toHaveBeenCalled()
      } finally {
        capacitorWindow.Capacitor = previous
      }
    }
  )

  it("returns unsupported without prompting when neither Android push service is available", async () => {
    const fcm = makePlugin()
    const previous = capacitorWindow.Capacitor
    capacitorWindow.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: {
        CogniaDeviceServices: { getStatus: async () => ({ status: 1 }) },
        CogniaHuaweiPush: {
          getStatus: async () => ({ configured: false, available: false, status: 1 }),
        },
        PushNotifications: fcm.plugin,
      },
    }
    try {
      await expect(registerPushNotifications()).resolves.toEqual({ kind: "unsupported" })
      expect(fcm.plugin.requestPermissions).not.toHaveBeenCalled()
      expect(fcm.register).not.toHaveBeenCalled()
    } finally {
      capacitorWindow.Capacitor = previous
    }
  })
  it("returns registered + token on a happy path", async () => {
    const fake = makePlugin({ initialPerm: "granted", token: "abc-123" })
    const previous = capacitorWindow.Capacitor
    capacitorWindow.Capacitor = { getPlatform: () => "ios" }
    try {
      const out = await registerPushNotifications({ loader: async () => fake.plugin })
      expect(out).toEqual({
        kind: "registered",
        token: "abc-123",
        platform: "ios",
        provider: "apns",
      })
    } finally {
      capacitorWindow.Capacitor = previous
    }
  })

  it("uses the native global plugin registered by the mobile boot", async () => {
    const fake = makePlugin({ initialPerm: "granted", token: "global-token" })
    const previous = capacitorWindow.Capacitor
    capacitorWindow.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: { PushNotifications: fake.plugin },
    }
    try {
      await expect(registerPushNotifications()).resolves.toEqual({
        kind: "registered",
        token: "global-token",
        platform: "android",
        provider: "fcm",
      })
    } finally {
      capacitorWindow.Capacitor = previous
    }
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

  it("reports permission_required without prompting during passive startup", async () => {
    const fake = makePlugin({ initialPerm: "prompt" })
    const out = await registerPushNotifications({
      loader: async () => fake.plugin,
      requestPermission: false,
    })

    expect(out).toEqual({ kind: "permission_required" })
    expect(fake.plugin.requestPermissions).not.toHaveBeenCalled()
    expect(fake.plugin.register).not.toHaveBeenCalled()
  })

  it("reports permission_denied without prompting during passive startup", async () => {
    const fake = makePlugin({ initialPerm: "denied" })
    const out = await registerPushNotifications({
      loader: async () => fake.plugin,
      requestPermission: false,
    })

    expect(out).toEqual({ kind: "permission_denied" })
    expect(fake.plugin.requestPermissions).not.toHaveBeenCalled()
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

  it("uses a fallback message for an empty native registration error", async () => {
    const fake = makePlugin({ initialPerm: "granted", token: null, registrationError: "" })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out).toEqual({ kind: "registration_failed", message: "unknown registration error" })
  })

  it("returns registration_failed when permission lookup throws", async () => {
    const fake = makePlugin({ permThrows: new Error("kaboom") })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out.kind).toBe("registration_failed")
  })

  it("normalizes non-Error permission failures", async () => {
    const fake = makePlugin({ permThrows: "permission bridge failed" })
    const out = await registerPushNotifications({ loader: async () => fake.plugin })
    expect(out).toEqual({ kind: "registration_failed", message: "permission bridge failed" })
  })

  it("normalizes listener setup failures and does not register", async () => {
    const fake = makePlugin({ initialPerm: "granted" })
    fake.plugin.addListener.mockRejectedValueOnce("listener bridge failed")

    const out = await registerPushNotifications({ loader: async () => fake.plugin })

    expect(out).toEqual({ kind: "registration_failed", message: "listener bridge failed" })
    expect(fake.plugin.register).not.toHaveBeenCalled()
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
  it("reports a Huawei token under hms rather than deriving FCM from Android", async () => {
    const transport = {
      call: jest.fn().mockResolvedValue(null),
      subscribe: jest.fn(() => () => {}),
    }
    await expect(
      reportPushTokenToDesktop("hms-token", "android", transport, "hms")
    ).resolves.toEqual({ ok: true })
    expect(transport.call).toHaveBeenCalledWith("register_push_token", {
      token: "hms-token",
      provider: "hms",
    })
  })
  it("calls _rpc/register_push_token via the transport", async () => {
    const transport = {
      call: jest.fn().mockResolvedValue({}),
      subscribe: jest.fn(() => () => {}),
    }
    const out = await reportPushTokenToDesktop("tok", "ios", transport)
    expect(out).toEqual({ ok: true })
    expect(transport.call).toHaveBeenCalledWith("register_push_token", {
      token: "tok",
      provider: "apns",
    })
  })

  it("maps Android registration to the FCM provider", async () => {
    const transport = {
      call: jest.fn().mockResolvedValue({}),
      subscribe: jest.fn(() => () => {}),
    }

    await expect(reportPushTokenToDesktop("tok", "android", transport)).resolves.toEqual({
      ok: true,
    })
    expect(transport.call).toHaveBeenCalledWith("register_push_token", {
      token: "tok",
      provider: "fcm",
    })
  })

  it("does not send an invalid provider when the native platform is unknown", async () => {
    const transport = {
      call: jest.fn().mockResolvedValue({}),
      subscribe: jest.fn(() => () => {}),
    }

    const out = await reportPushTokenToDesktop("tok", "unknown", transport)

    expect(out).toEqual({ ok: false, reason: "unsupported push platform: unknown" })
    expect(transport.call).not.toHaveBeenCalled()
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

  it("normalizes a non-Error transport rejection", async () => {
    const transport = {
      call: jest.fn().mockRejectedValue("offline"),
      subscribe: jest.fn(() => () => {}),
    }
    await expect(reportPushTokenToDesktop("tok", "android", transport)).resolves.toEqual({
      ok: false,
      reason: "offline",
    })
  })
})

describe("subscribeToPushNotifications", () => {
  it("receives Huawei taps without probing availability, even before registration succeeds", async () => {
    const hms = makePlugin({ initialPerm: "granted" })
    const getStatus = jest.fn().mockRejectedValue(new Error("temporary service failure"))
    const previous = capacitorWindow.Capacitor
    capacitorWindow.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: { CogniaHuaweiPush: { ...hms.plugin, getStatus } },
    }
    try {
      const handler = jest.fn()
      const teardown = await subscribeToPushNotifications(handler)
      hms.listeners.pushNotificationActionPerformed.forEach((listener) =>
        listener({
          notification: { title: "Ready", data: { sessionId: "session-a" } },
          actionId: "tap",
        })
      )
      expect(handler).toHaveBeenCalledWith({
        title: "Ready",
        body: undefined,
        data: { sessionId: "session-a" },
        foreground: false,
      })
      expect(getStatus).not.toHaveBeenCalled()
      await teardown()
      expect(hms.removers.every((remove) => remove.mock.calls.length === 1)).toBe(true)
    } finally {
      capacitorWindow.Capacitor = previous
    }
  })

  it("forwards only the registered service's refresh when both native services emit tokens", async () => {
    const hms = makePlugin({ initialPerm: "granted", token: "hms-first" })
    const fcm = makePlugin({ initialPerm: "granted" })
    const previous = capacitorWindow.Capacitor
    capacitorWindow.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: {
        CogniaHuaweiPush: {
          ...hms.plugin,
          getStatus: async () => ({ configured: true, available: true, status: 0 }),
        },
        PushNotifications: fcm.plugin,
      },
    }
    try {
      const handler = jest.fn()
      const teardown = await subscribeToPushTokenChanges(handler)
      await registerPushNotifications({ requestPermission: false })
      handler.mockClear()
      fcm.listeners.registration.forEach((listener) => listener({ value: "wrong-provider" }))
      hms.listeners.registration.forEach((listener) => listener({ value: "hms-new" }))
      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith({
        token: "hms-new",
        platform: "android",
        provider: "hms",
      })
      await teardown()
    } finally {
      capacitorWindow.Capacitor = previous
    }
  })

  it("removes the first listener if installing the action listener fails", async () => {
    const fake = makePlugin()
    fake.plugin.addListener
      .mockImplementationOnce(async (event, handler) => {
        fake.listeners[event] = [handler]
        return {
          remove: jest.fn(async () => {
            fake.listeners[event] = []
          }),
        }
      })
      .mockRejectedValueOnce(new Error("listener failed"))
    await expect(
      subscribeToPushNotifications(jest.fn(), { loader: async () => fake.plugin })
    ).rejects.toThrow("listener failed")
    expect(fake.listeners.pushNotificationReceived).toEqual([])
  })
  it("forwards rotated Huawei tokens and stops forwarding after teardown", async () => {
    const hms = makePlugin()
    const handler = jest.fn()
    const teardown = await subscribeToPushTokenChanges(handler, {
      loader: async () => hms.plugin,
      provider: "hms",
    })
    hms.listeners.registration.forEach((listener) => listener({ value: "rotated-token" }))
    expect(handler).toHaveBeenCalledWith({
      token: "rotated-token",
      platform: "unknown",
      provider: "hms",
    })
    await teardown()
    hms.listeners.registration.forEach((listener) => listener({ value: "after-teardown" }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
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

    fake.listeners["pushNotificationReceived"]?.forEach((h) => h({ title: "no data" }))
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: {}, foreground: true })
    )

    await teardown()
  })

  it("best-effort teardown tolerates both native listener removals failing", async () => {
    const fake = makePlugin({ initialPerm: "granted" })
    const teardown = await subscribeToPushNotifications(jest.fn(), {
      loader: async () => fake.plugin,
    })
    for (const remove of fake.removers) remove.mockRejectedValueOnce(new Error("remove failed"))

    await expect(teardown()).resolves.toBeUndefined()
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
