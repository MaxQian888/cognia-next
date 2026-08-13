"use client"

/**
 * Push notification registration façade (M4.6 / #50).
 *
 * Wraps `@capacitor/push-notifications` so the rest of the app can talk
 * about "register / token / pushReceived" without caring whether the
 * underlying plugin actually loaded (web build → no plugin → graceful
 * `unsupported`).
 *
 * Server-side delivery is HITL Rust work. The client side here:
 *   1. Checks OS permission and only prompts when the caller explicitly asks.
 *   2. Triggers APNs / FCM registration.
 *   3. Surfaces the device token to the caller (which posts it to the
 *      desktop via `_rpc/register_push_token`).
 *   4. Exposes a subscribe-style listener for inbound push events so the
 *      UI can route them to a banner / inbox.
 */

import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { transport as defaultTransport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"

export type PushPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale"

export type RegistrationOutcome =
  | { kind: "registered"; token: string; platform: PushPlatform }
  | { kind: "permission_required" }
  | { kind: "permission_denied" }
  | { kind: "unsupported" }
  | { kind: "registration_failed"; message: string }

export type PushPlatform = "ios" | "android" | "unknown"

export interface PushDelivery {
  /** Title shown in the OS banner. */
  title?: string
  /** Body shown in the OS banner. */
  body?: string
  /** Server-supplied data payload (deep-link, session id, etc). */
  data: Record<string, unknown>
  /** Whether the app was foreground when delivered. */
  foreground: boolean
}

interface PushNotificationsPluginShape {
  checkPermissions(): Promise<{ receive: PushPermission }>
  requestPermissions(): Promise<{ receive: PushPermission }>
  register(): Promise<void>
  addListener(
    event: "registration",
    handler: (token: { value: string }) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: "registrationError",
    handler: (err: { error: string }) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: "pushNotificationReceived",
    handler: (notification: {
      title?: string
      body?: string
      data?: Record<string, unknown>
    }) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: "pushNotificationActionPerformed",
    handler: (action: {
      notification: { title?: string; body?: string; data?: Record<string, unknown> }
      actionId: string
    }) => void
  ): Promise<{ remove: () => Promise<void> }>
}

export type PushPluginLoader = () => Promise<PushNotificationsPluginShape>

// Resolve through the shared loader: window.Capacitor.Plugins.PushNotifications
// first (populated by registerNativePlugins at mobile boot), then the dynamic
// import. A bare import alone always rejects inside the static-export WebView
// (the npm module isn't bundled), which silently killed the whole push chain.
const defaultLoader: PushPluginLoader = makeDefaultLoader<PushNotificationsPluginShape>(
  "@capacitor/push-notifications",
  "PushNotifications"
)

function detectPlatform(): PushPlatform {
  if (typeof window === "undefined") return "unknown"
  const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const value = cap?.getPlatform?.()
  if (value === "ios" || value === "android") return value
  return "unknown"
}

interface RegisterOptions {
  loader?: PushPluginLoader
  /** Maximum time to wait for the registration event (ms). */
  timeoutMs?: number
  /** Whether this call may show the native permission prompt. */
  requestPermission?: boolean
}

/**
 * Walk through the full permission → register → token flow. Resolves
 * with a typed outcome — never throws. Passive startup callers can set
 * `requestPermission: false` and leave the prompt to the contextual CTA.
 */
export async function registerPushNotifications(
  opts: RegisterOptions = {}
): Promise<RegistrationOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  let plugin: PushNotificationsPluginShape
  try {
    plugin = await (opts.loader ?? defaultLoader)()
  } catch {
    return { kind: "unsupported" }
  }

  let perm: { receive: PushPermission }
  try {
    perm = await plugin.checkPermissions()
    if (perm.receive !== "granted") {
      if (opts.requestPermission === false) {
        return perm.receive === "denied"
          ? { kind: "permission_denied" }
          : { kind: "permission_required" }
      }
      perm = await plugin.requestPermissions()
    }
  } catch (err: unknown) {
    return {
      kind: "registration_failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
  if (perm.receive !== "granted") {
    return { kind: "permission_denied" }
  }

  return new Promise<RegistrationOutcome>((resolve) => {
    let settled = false
    const settle = (outcome: RegistrationOutcome) => {
      if (settled) return
      settled = true
      void cleanup()
      resolve(outcome)
    }

    const removers: Array<() => Promise<void>> = []
    const cleanup = async () => {
      for (const r of removers) {
        try {
          await r()
        } catch {
          // best-effort
        }
      }
    }

    const timeoutId = setTimeout(() => {
      settle({
        kind: "registration_failed",
        message: `registration did not return a token within ${timeoutMs}ms`,
      })
    }, timeoutMs)

    Promise.resolve()
      .then(async () => {
        const regHandle = await plugin.addListener("registration", (token) => {
          clearTimeout(timeoutId)
          settle({
            kind: "registered",
            token: token.value,
            platform: detectPlatform(),
          })
        })
        removers.push(regHandle.remove)

        const errHandle = await plugin.addListener("registrationError", (err) => {
          clearTimeout(timeoutId)
          settle({
            kind: "registration_failed",
            message: err.error || "unknown registration error",
          })
        })
        removers.push(errHandle.remove)

        await plugin.register()
      })
      .catch((err: unknown) => {
        clearTimeout(timeoutId)
        settle({
          kind: "registration_failed",
          message: err instanceof Error ? err.message : String(err),
        })
      })
  })
}

/**
 * Send the captured token to the desktop server. Caller is the boot
 * provider. Server-side `_rpc/register_push_token` is HITL Rust work; we
 * still call it so a working server picks the token up automatically.
 */
export async function reportPushTokenToDesktop(
  token: string,
  platform: PushPlatform,
  transport: Transport = defaultTransport
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const provider = platform === "ios" ? "apns" : platform === "android" ? "fcm" : null
  if (!provider) {
    return { ok: false, reason: `unsupported push platform: ${platform}` }
  }
  try {
    await transport.call("register_push_token", { token, provider })
    return { ok: true }
  } catch (err: unknown) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

interface SubscribeOptions {
  loader?: PushPluginLoader
}

/**
 * Subscribe to inbound `pushNotificationReceived` and
 * `pushNotificationActionPerformed` events. Returns a teardown.
 */
export async function subscribeToPushNotifications(
  handler: (delivery: PushDelivery) => void,
  opts: SubscribeOptions = {}
): Promise<() => Promise<void>> {
  let plugin: PushNotificationsPluginShape
  try {
    plugin = await (opts.loader ?? defaultLoader)()
  } catch {
    return async () => {}
  }

  const receivedHandle = await plugin.addListener("pushNotificationReceived", (notification) => {
    handler({
      title: notification.title,
      body: notification.body,
      data: notification.data ?? {},
      foreground: true,
    })
  })
  const actionHandle = await plugin.addListener("pushNotificationActionPerformed", (action) => {
    handler({
      title: action.notification.title,
      body: action.notification.body,
      data: action.notification.data ?? {},
      foreground: false,
    })
  })

  return async () => {
    try {
      await receivedHandle.remove()
    } catch {
      /* best-effort */
    }
    try {
      await actionHandle.remove()
    } catch {
      /* best-effort */
    }
  }
}
