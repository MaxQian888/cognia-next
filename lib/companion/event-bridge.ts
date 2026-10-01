/**
 * Rust → Dexie event bridge for the mobile-companion subsystem.
 *
 * The Rust registration handler emits `companion://device-paired` after a
 * successful cgnp3 device registration; the DPoP verifier middleware emits
 * `companion://device-seen` on every authenticated request
 * (`src-tauri/src/companion_api/middleware.rs`). This module subscribes to
 * both via the shared `transport` and persists the payloads to Dexie's
 * `pairedDevices` table so the M2.8 settings UI sees real-time updates.
 *
 * Mounted once at app startup by `CompanionEventBridgeProvider`.
 */

import { DEFAULT_ACCOUNT_NAMESPACE } from "@/lib/companion/account-namespace"
import { detachDevice } from "@/lib/companion/remote-attach-registry"
import { releaseDeviceAttachmentUploads } from "@/lib/db/session-attachment-uploads"
import { noteDeviceSeen } from "@/lib/companion/device-presence-registry"
import { addPairedDevice, touchPairedDevice } from "@/lib/db/paired-devices"
import { transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getRuntimeTranslator } from "@/lib/i18n/runtime-translator"
import { notify } from "@/lib/notifications/runtime"
import { useAccountStore } from "@/stores/account/account-store"
import type { DevicePlatform } from "@/types/mobile/paired-device"
import type { RoomDescriptor } from "@/lib/signaling/crypto"

// ---------------------------------------------------------------------------
// Event payloads — mirror the JSON shape emitted by the Rust handlers.
// ---------------------------------------------------------------------------

interface DevicePairedPayload {
  device_id: string
  account_id?: string
  label: string
  platform: string
  pubkey: string
  paired_at_ms: number
  app_version: string
  /** ADR-0021: optional for legacy desktop servers that predate WebRTC. */
  rendezvous_id?: string
  room_descriptor?: RoomDescriptor
  signaling_key_ref?: string
}

interface DeviceSeenPayload {
  device_id: string
  account_id?: string
  seen_at_ms: number
}

/**
 * `companion://device-lifecycle`, emitted by
 * `src-tauri/src/companion_api/device_lifecycle.rs` after a pairing is
 * suspended, revoked or restored. Rust drops the device's event-plane leases
 * itself; the attach leases live only in this renderer, so nothing but this
 * handler can release them.
 */
interface DeviceLifecyclePayload {
  deviceId: string
  tenantId?: string
  action: string
  state: string
}

/** Lifecycle actions that end a device's authority to drive a session. */
const AUTHORITY_ENDING_ACTIONS: ReadonlySet<string> = new Set(["suspend", "revoke"])

// `browser` is the extension (ADR-0154). Left out, a registered browser was
// mirrored as `unknown`, which the device console cannot tell from a phone that
// would not say what it was.
const KNOWN_PLATFORMS: ReadonlySet<DevicePlatform> = new Set([
  "ios",
  "android",
  "web",
  "browser",
  "unknown",
])

function normalizePlatform(value: string): DevicePlatform {
  return KNOWN_PLATFORMS.has(value as DevicePlatform) ? (value as DevicePlatform) : "unknown"
}

// ---------------------------------------------------------------------------
// Public installer
// ---------------------------------------------------------------------------

/**
 * Subscribe to the two companion events and persist them to Dexie. Returns a
 * detach function that removes both listeners — call it on unmount or hot
 * reload to avoid double-handling.
 *
 * Failures inside the handlers are swallowed: the Dexie write is best-effort
 * (the verifier middleware already runs on a `tokio::spawn`, so a missed
 * persistence is a UI lag — never a request failure).
 */
export function installCompanionEventBridge(): () => void {
  const unsubPaired = transport.subscribe<DevicePairedPayload>(
    "companion://device-paired",
    (payload) => {
      void handleDevicePaired(payload)
    }
  )

  const unsubSeen = transport.subscribe<DeviceSeenPayload>("companion://device-seen", (payload) => {
    void handleDeviceSeen(payload)
  })

  // Attach leases are renderer-owned, so a suspension or revocation reaches
  // them only here. Without this the device kept its control lease for the full
  // 90s TTL: the Host went on routing `permission_request` frames at a phone
  // that had just lost the right to answer them, and each one sat until the
  // 120s approval backstop denied it.
  const unsubLifecycle = transport.subscribe<DeviceLifecyclePayload>(
    "companion://device-lifecycle",
    (payload) => {
      if (!payload?.deviceId) return
      if (!AUTHORITY_ENDING_ACTIONS.has(payload.action)) return
      detachDevice(payload.deviceId)
      // Its staged attachments go with it. Those bytes exist only so a message
      // from that device can carry them, and it may no longer send one — a
      // suspended phone's half-uploaded screenshot would otherwise sit on the
      // desktop's disk until the 30-minute collector noticed.
      void releaseDeviceAttachmentUploads(payload.deviceId).catch(() => undefined)
    }
  )

  return () => {
    unsubPaired()
    unsubSeen()
    unsubLifecycle()
  }
}

async function handleDevicePaired(payload: DevicePairedPayload): Promise<void> {
  try {
    assertPayloadAccountMatchesActiveAccount(payload.account_id)
    await addPairedDevice({
      deviceId: payload.device_id,
      accountId: payload.account_id,
      label: payload.label,
      platform: normalizePlatform(payload.platform),
      pubkey: payload.pubkey,
      appVersion: payload.app_version,
      rendezvousId: payload.rendezvous_id,
      signalingRoomDescriptor: payload.room_descriptor,
      signalingKeyRef: payload.signaling_key_ref,
      nowMs: payload.paired_at_ms,
    })
  } catch (err) {
    // Dexie unavailable / closed during shutdown — non-fatal.
    console.warn("companion event-bridge: addPairedDevice failed", err)
    return
  }
  await announceDevicePaired(payload)
}

/** Window in which a pairing is still news; older ones arrive only on replay. */
export const PAIRING_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Tell this person that a device was paired with their Host.
 *
 * `companion://device-paired` reaches every paired client and the Host's own
 * renderer (`ChannelAudience::Any`, default on). Mirroring it into
 * `pairedDevices` alone meant nobody was told, which is the one thing a
 * pairing someone else made must not be. Signal and Google both alert every
 * other signed-in device for the same reason.
 *
 * Skipped on the device that was just paired (it would be announcing itself)
 * and for pairings older than the event plane's replay window, which a
 * reconnecting client receives again. The dedupe key makes a replay inside
 * the window bump the existing row rather than add one.
 */
export async function announceDevicePaired(
  payload: Pick<DevicePairedPayload, "device_id" | "label" | "platform" | "paired_at_ms">,
  now: number = Date.now()
): Promise<void> {
  try {
    const ownDeviceId = loadCompanionConfig()?.deviceId
    if (ownDeviceId && ownDeviceId === payload.device_id) return
    if (now - payload.paired_at_ms > PAIRING_ALERT_WINDOW_MS) return
    const t = await getRuntimeTranslator("devices.pairingAlert")
    await notify({
      source: "system",
      level: "warning",
      title: t("title"),
      body: t("body", {
        label: payload.label || payload.device_id,
        platform: normalizePlatform(payload.platform),
      }),
      href: "/devices",
      dedupeKey: `device-paired:${payload.device_id}`,
      sourceRef: { kind: "paired-device", id: payload.device_id },
      directed: true,
    })
  } catch (err) {
    // A failed alert must not undo the pairing row written above.
    console.warn("companion event-bridge: pairing alert failed", err)
  }
}

async function handleDeviceSeen(payload: DeviceSeenPayload): Promise<void> {
  try {
    assertPayloadAccountMatchesActiveAccount(payload.account_id)
    // Feeds the presence label. Durable last-seen goes to Dexie below; this is
    // the in-memory half the paired-devices view reads for "recently active".
    noteDeviceSeen(payload.device_id, payload.seen_at_ms)
    await touchPairedDevice(payload.device_id, payload.seen_at_ms)
  } catch (err) {
    console.warn("companion event-bridge: touchPairedDevice failed", err)
  }
}

/**
 * Refuse a companion event that belongs to somebody else's account.
 *
 * `account_id` on these payloads is a **local account namespace**. It used to
 * be the Rust-side *tenant*, which is a different id space — so under a real
 * `acct_…` account this comparison could never succeed and no paired-device
 * row was ever written. Rust now translates at the emit boundary
 * (`host_identity::event_namespace_for_tenant`).
 *
 * {@link DEFAULT_ACCOUNT_NAMESPACE} is accepted and adopted into the unlocked
 * account: a device can pair before anyone has unlocked, and the Host stamps
 * the sentinel until a verified unlock binds it. This is exactly how the
 * credential book already treats the unclaimed bucket — the first account
 * activation takes it over — and `pair-onboarding-client` already assumes
 * pairing can precede account context.
 */
function assertPayloadAccountMatchesActiveAccount(payloadAccountId: string | undefined): void {
  const activeAccountId = useAccountStore.getState().unlockedAccountId
  if (!activeAccountId) {
    throw new Error("companion event rejected: no unlocked local account")
  }
  if (!payloadAccountId) {
    throw new Error("companion event rejected: missing local account id")
  }
  if (payloadAccountId === DEFAULT_ACCOUNT_NAMESPACE) {
    return
  }
  if (payloadAccountId !== activeAccountId) {
    throw new Error("companion event rejected: account mismatch")
  }
}
