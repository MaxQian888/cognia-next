"use client"

/**
 * Push notification registration façade (M4.6 / #50).
 *
 * Wraps `@capacitor/push-notifications` so the rest of the app can talk
 * about "register / token / pushReceived" without caring whether the
 * underlying plugin actually loaded (web build → no plugin → graceful
 * `unsupported`).
 *
 * The companion host sends remote notifications. The client side here:
 *   1. Checks OS permission and only prompts when the caller explicitly asks.
 *   2. Triggers APNs / FCM / Huawei HMS registration.
 *   3. Surfaces the device token to the caller (which posts it to the
 *      desktop via `_rpc/register_push_token`).
 *   4. Exposes a subscribe-style listener for inbound push events so the
 *      UI can route them to a banner / inbox.
 */

import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { getGooglePlayServicesStatus } from "@/lib/capacitor/google-play-services"
import { transport as defaultTransport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"

export type PushPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale"

export type RegistrationOutcome =
  | ({ kind: "registered" } & PushRegistration)
  | { kind: "permission_required" }
  | { kind: "permission_denied" }
  | { kind: "unsupported" }
  | { kind: "registration_failed"; message: string }

export type PushPlatform = "ios" | "android" | "unknown"
export type PushProvider = "apns" | "fcm" | "hms"

export interface PushRegistration {
  token: string
  platform: PushPlatform
  /** Separate from OS: Android devices can register with FCM or Huawei HMS. */
  provider?: PushProvider
}

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
const loadStandardPush: PushPluginLoader = makeDefaultLoader<PushNotificationsPluginShape>(
  "@capacitor/push-notifications",
  "PushNotifications"
)

interface HuaweiPushPluginShape extends PushNotificationsPluginShape {
  getStatus(): Promise<{ configured: boolean; available: boolean; status: number }>
}

const loadHuaweiPush = makeDefaultLoader<HuaweiPushPluginShape>(
  "CogniaHuaweiPush",
  "CogniaHuaweiPush"
)

// Token events must follow the service selected for registration. Receiving
// notifications listens to both native plugins so cold taps do not depend on
// a successful availability probe or a fresh registration.
let activePushProvider: { runtime: unknown; provider: PushProvider | undefined } | undefined
function nativeRuntime(): unknown {
  return (globalThis as { Capacitor?: unknown }).Capacitor
}

function providerForPlatform(platform: PushPlatform): PushProvider | undefined {
  return platform === "ios" ? "apns" : platform === "android" ? "fcm" : undefined
}

async function selectPushPlugin(opts: SubscribeOptions): Promise<{
  plugin: PushNotificationsPluginShape
  platform: PushPlatform
  provider?: PushProvider
}> {
  const platform = detectPlatform()
  if (opts.loader) {
    return {
      plugin: await opts.loader(),
      platform,
      provider: opts.provider ?? providerForPlatform(platform),
    }
  }
  if (platform === "android") {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const huawei = await loadHuaweiPush()
      const status = await Promise.race([
        huawei.getStatus(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 2_000)
        }),
      ])
      if (status?.configured && status.available) {
        return { plugin: huawei, platform, provider: "hms" }
      }
    } catch {
      // Older Android shells do not advertise the Huawei bridge.
    } finally {
      clearTimeout(timer)
    }
    const google = await getGooglePlayServicesStatus()
    // Unknown preserves compatibility with older shells without a service
    // probe. A confirmed missing GMS must never trigger FCM registration.
    if (!google.available && google.status !== "unknown")
      throw new Error("No configured Android push service")
  }
  return { plugin: await loadStandardPush(), platform, provider: providerForPlatform(platform) }
}

function detectPlatform(): PushPlatform {
  if (typeof window === "undefined") return "unknown"
  const cap = (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor
  const value = cap?.getPlatform?.()
  if (value === "ios" || value === "android") return value
  return "unknown"
}

interface RegisterOptions {
  loader?: PushPluginLoader
  provider?: PushProvider
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
  let selected: Awaited<ReturnType<typeof selectPushPlugin>>
  try {
    selected = await selectPushPlugin(opts)
  } catch {
    return { kind: "unsupported" }
  }
  const { plugin, platform, provider } = selected

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
  if (!opts.loader) activePushProvider = { runtime: nativeRuntime(), provider }

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
          if (!token.value?.trim()) return
          clearTimeout(timeoutId)
          settle({
            kind: "registered",
            token: token.value,
            platform,
            ...(provider ? { provider } : {}),
          })
        })
        if (settled) {
          await regHandle.remove()
          return
        }
        removers.push(regHandle.remove)

        const errHandle = await plugin.addListener("registrationError", (err) => {
          clearTimeout(timeoutId)
          settle({
            kind: "registration_failed",
            message: err.error || "unknown registration error",
          })
        })
        if (settled) {
          await errHandle.remove()
          return
        }
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
 * Send the captured token and selected provider to the companion host.
 * The boot provider also calls this after token rotation and reconnection.
 */
export async function reportPushTokenToDesktop(
  token: string,
  platform: PushPlatform,
  transport: Transport = defaultTransport,
  selectedProvider?: PushProvider
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const provider = selectedProvider ?? providerForPlatform(platform)
  if (
    !provider ||
    platform === "unknown" ||
    (platform === "ios" ? provider !== "apns" : provider === "apns")
  ) {
    return { ok: false, reason: `unsupported push platform: ${platform}` }
  }
  if (!token.trim()) return { ok: false, reason: "empty push token" }
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
  provider?: PushProvider
}

async function pushEventSources(opts: SubscribeOptions) {
  if (opts.loader) return [await selectPushPlugin(opts)]
  const platform = detectPlatform()
  const plugins = (nativeRuntime() as { Plugins?: Record<string, unknown> } | undefined)?.Plugins
  const sources: Array<
    Promise<{
      plugin: PushNotificationsPluginShape
      platform: PushPlatform
      provider?: PushProvider
    }>
  > = []
  if (plugins?.PushNotifications) {
    sources.push(
      loadStandardPush().then((plugin) => ({
        plugin,
        platform,
        provider: providerForPlatform(platform),
      }))
    )
  }
  if (platform === "android" && plugins?.CogniaHuaweiPush) {
    sources.push(
      loadHuaweiPush().then((plugin) => ({ plugin, platform, provider: "hms" as const }))
    )
  }
  const loaded = await Promise.allSettled(sources)
  return loaded.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
}

/** Observe native token rotation for the currently bound host. */
export async function subscribeToPushTokenChanges(
  handler: (registration: PushRegistration) => void,
  opts: SubscribeOptions = {}
): Promise<() => Promise<void>> {
  let sources: Awaited<ReturnType<typeof pushEventSources>>
  try {
    sources = await pushEventSources(opts)
  } catch {
    return async () => {}
  }
  let active = true
  const removers: Array<() => Promise<void>> = []
  try {
    for (const { plugin, platform, provider } of sources) {
      const listener = await plugin.addListener("registration", ({ value }) => {
        const selected =
          opts.loader ||
          (activePushProvider?.runtime === nativeRuntime() &&
            activePushProvider?.provider === provider)
        if (active && selected && value?.trim())
          handler({ token: value, platform, ...(provider ? { provider } : {}) })
      })
      removers.push(() => listener.remove())
    }
  } catch (error) {
    active = false
    await Promise.allSettled(removers.map((remove) => remove()))
    throw error
  }
  return async () => {
    active = false
    await Promise.allSettled(removers.map((remove) => remove()))
  }
}

/**
 * Subscribe to inbound `pushNotificationReceived` and
 * `pushNotificationActionPerformed` events. Returns a teardown.
 */
export async function subscribeToPushNotifications(
  handler: (delivery: PushDelivery) => void,
  opts: SubscribeOptions = {}
): Promise<() => Promise<void>> {
  let sources: Awaited<ReturnType<typeof pushEventSources>>
  try {
    sources = await pushEventSources(opts)
  } catch {
    return async () => {}
  }

  let active = true
  const removers: Array<() => Promise<void>> = []
  try {
    for (const { plugin } of sources) {
      const receivedHandle = await plugin.addListener(
        "pushNotificationReceived",
        (notification) => {
          if (!active) return
          handler({
            title: notification.title,
            body: notification.body,
            data: notification.data ?? {},
            foreground: true,
          })
        }
      )
      removers.push(() => receivedHandle.remove())
      const actionHandle = await plugin.addListener("pushNotificationActionPerformed", (action) => {
        if (!active) return
        handler({
          title: action.notification.title,
          body: action.notification.body,
          data: action.notification.data ?? {},
          foreground: false,
        })
      })
      removers.push(() => actionHandle.remove())
    }
  } catch (error) {
    active = false
    await Promise.allSettled(removers.map((remove) => remove()))
    throw error
  }
  return async () => {
    active = false
    await Promise.allSettled(removers.map((remove) => remove()))
  }
}
