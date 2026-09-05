"use client"

/**
 * Remote Session Control — the Host's single view of which paired devices are
 * present, and what each of them is currently allowed to drive.
 *
 * This replaces a plain `sessionId → Set<deviceId>` map that had no expiry and
 * no notion of *how* a device was watching. Three things went wrong with that
 * shape, and each is why a field here exists:
 *
 * 1. **Nothing ever expired.** A phone that lost its socket stayed "attached"
 *    forever, so the Host kept routing approval prompts at a device that was
 *    gone and let them run out the backstop timer. Every attachment is now a
 *    lease with a TTL the client must renew.
 * 2. **Observing and controlling were the same bit.** A device with read access
 *    could be handed an actionable approval. `mode` splits them: an observer
 *    sees that a decision exists, a controller may answer it.
 * 3. **A live RPC channel was mistaken for a live event channel.** A device can
 *    answer HTTP while its `/ws/events` stream is dead — it can *ask* but not
 *    *hear*, so it must not hold effective control. `eventPlane` tracks that
 *    independently of whether the device is reachable at all.
 *
 * Process-global and in-memory on purpose: it describes live connections, which
 * do not survive a Host restart. Everything durable (pairing, capability
 * grants) lives in the SecurityStore and `pairedDevices`. The clock is a
 * parameter on every call so leases are testable without fake timers.
 */

/** How long an attachment survives without a renewal. */
export const ATTACH_LEASE_TTL_MS = 90_000

/** How often a client should renew — a third of the TTL, so two renewals may
 *  be lost to a flaky link before the lease actually drops. */
export const ATTACH_LEASE_RENEW_INTERVAL_MS = 30_000

/**
 * How long after its last sighting a device still reads as "recently active" in
 * the UI. Deliberately NOT usable for control decisions: recently-active means
 * "worth showing", `effectiveController` means "may act".
 */
export const RECENTLY_ACTIVE_WINDOW_MS = 5 * 60_000

/**
 * Where a device stands on the event plane.
 *
 * `degraded` has a producer since ADR-0170 batch 4: a device that lost every
 * event stream, kept making authenticated requests afterwards, and has been
 * without a stream for longer than one lease renewal interval. That is the
 * "RPC answers, events do not" shape a user experiences as changes made
 * elsewhere never appearing, and it is distinct from `disconnected`, where the
 * device is simply gone. Pinned by `derives a degraded event plane`.
 */
export type EventPlaneState = "disconnected" | "connecting" | "replaying" | "ready" | "degraded"

/**
 * How far along one stream is, as the Host reports it. Strictly a position in
 * the handshake, not a health rating: `replaying` is a correctly working stream
 * that is still behind.
 */
export type EventStreamState = "connecting" | "replaying" | "ready"

/** Whether the user is actually looking at the device. Drives push suppression. */
export type DeviceAttention = "foreground" | "background" | "unknown"

/** What an attachment entitles the device to do. */
export type AttachMode = "observe" | "control"

/** Transport a device's event stream arrived on. Both may be open at once. */
export type PresenceTransport = "ws" | "rtc"

/**
 * One live event-plane connection, as the Host's Rust side sees it.
 *
 * Every field is server-minted (`src-tauri/src/companion_api/event_leases.rs`)
 * and arrives on `session_attach` as `callerEventStreams`. The renderer used to
 * mint its own synthetic id for a single imagined connection, which could not
 * express the two states that matter: a device holding two transports at once,
 * and a socket that has upgraded but not yet caught up.
 */
export interface EventStreamConnection {
  /** Server-minted. An attachment names it to bind itself to this stream. */
  leaseId: string
  transport: PresenceTransport
  state: EventStreamState
  openedAt: number
}

export interface AttachLease {
  sessionId: string
  deviceId: string
  mode: AttachMode
  /**
   * The event-stream connection this attachment is bound to. A control lease
   * is only as good as the stream that carries the work it is controlling, so
   * when that stream closes the lease stops conferring effective control even
   * though it survives to its TTL (see {@link effectiveController}).
   */
  eventStreamLeaseId: string
  expiresAt: number
  attachedAt: number
}

export interface DevicePresence {
  deviceId: string
  lastSeenAt: number
  /** Derived from {@link DevicePresence.streams}; never set independently. */
  eventPlane: EventPlaneState
  attention: DeviceAttention
  streams: EventStreamConnection[]
}

/** Coarse presence for display. Never a control input. */
export type PresenceLabel = "online" | "recently-active" | "offline"

interface DeviceRecord {
  deviceId: string
  lastSeenAt: number
  attention: DeviceAttention
  /** leaseId → stream. Authoritative copy of what Rust reported last. */
  streams: Map<string, EventStreamConnection>
  /**
   * When the last stream disappeared, or null while one is open (or none has
   * ever been). The clock `derivePlane` reads `degraded` against.
   */
  streamsLostAt: number | null
}

const devices = new Map<string, DeviceRecord>()
/** sessionId → deviceId → lease. */
const attachments = new Map<string, Map<string, AttachLease>>()

function record(deviceId: string): DeviceRecord {
  let existing = devices.get(deviceId)
  if (!existing) {
    existing = {
      deviceId,
      lastSeenAt: 0,
      attention: "unknown",
      streams: new Map(),
      streamsLostAt: null,
    }
    devices.set(deviceId, existing)
  }
  return existing
}

/**
 * The device's event plane, derived from its streams rather than stored.
 *
 * Stored separately it was a second source of truth for the same fact, and the
 * two drifted the moment a device held more than one transport: closing the
 * WebSocket wrote `disconnected` over a device whose WebRTC channel was still
 * delivering. Best state wins, because a device with any caught-up stream can
 * hear everything.
 */
function derivePlane(entry: DeviceRecord, at: number): EventPlaneState {
  let best: EventPlaneState = "disconnected"
  for (const stream of entry.streams.values()) {
    if (stream.state === "ready") return "ready"
    if (stream.state === "replaying") best = "replaying"
    else if (best === "disconnected") best = "connecting"
  }
  if (best === "disconnected" && isDegraded(entry, at)) return "degraded"
  return best
}

/**
 * No stream, but the device is still talking: it made an authenticated request
 * after its last stream closed, and the stream has now been gone for longer
 * than one renewal interval, which is past what a reconnect blip looks like.
 */
function isDegraded(entry: DeviceRecord, at: number): boolean {
  if (entry.streamsLostAt === null) return false
  if (entry.lastSeenAt <= entry.streamsLostAt) return false
  return at - entry.streamsLostAt > ATTACH_LEASE_RENEW_INTERVAL_MS
}

/**
 * Record that `deviceId` proved it was alive — any authenticated request, not
 * just an event-stream frame. Feeds the presence label only.
 */
export function noteDeviceSeen(deviceId: string, at: number): void {
  if (!deviceId) return
  const entry = record(deviceId)
  entry.lastSeenAt = Math.max(entry.lastSeenAt, at)
}

/**
 * Replace the device's event-stream set with what the Host just reported.
 *
 * A full replacement, not an add/remove delta: the Host enumerates every live
 * lease on each call, so anything absent from `streams` is gone. A delta would
 * have to guess at the closures it never saw — which is precisely how the old
 * model leaked, since a device that dropped its socket without a clean close
 * kept a phantom connection forever.
 *
 * Attachments bound to a stream that has disappeared are **kept**, not dropped.
 * A dropped stream is usually a reconnect, and the whole point of giving
 * attachments a TTL was that they outlive network churn: the device stops being
 * the {@link effectiveController} immediately, gets its authority back without
 * a re-attach when the stream returns, and only really loses it if it stays
 * away for the full lease. Releasing here instead would also erase the device
 * from {@link notifiableControllers} at exactly the moment a push became the
 * only way to reach it.
 */
export function syncEventStreams(input: {
  deviceId: string
  streams: readonly EventStreamConnection[]
  at: number
}): void {
  const entry = record(input.deviceId)
  const hadStreams = entry.streams.size > 0
  entry.streams = new Map(input.streams.map((stream) => [stream.leaseId, { ...stream }]))
  if (entry.streams.size > 0) entry.streamsLostAt = null
  else if (hadStreams) entry.streamsLostAt = input.at
  entry.lastSeenAt = Math.max(entry.lastSeenAt, input.at)
}

/**
 * The stream a control attachment should bind to: the device's oldest caught-up
 * one, or null when it has none.
 *
 * Oldest rather than newest so a reconnect in progress — a second socket that
 * has upgraded while the first still works — does not move an existing
 * attachment onto a stream that is about to replace it.
 */
export function readyEventStreamLeaseId(deviceId: string): string | null {
  const entry = devices.get(deviceId)
  if (!entry) return null
  let best: EventStreamConnection | null = null
  for (const stream of entry.streams.values()) {
    if (stream.state !== "ready") continue
    if (!best || stream.openedAt < best.openedAt) best = stream
  }
  return best?.leaseId ?? null
}

/** Every live stream the Host last reported for `deviceId`, oldest first. */
export function deviceEventStreams(deviceId: string): EventStreamConnection[] {
  const entry = devices.get(deviceId)
  if (!entry) return []
  return Array.from(entry.streams.values()).sort((a, b) => a.openedAt - b.openedAt)
}

/** The device's derived event-plane state. */
export function eventPlaneState(deviceId: string, at: number = Date.now()): EventPlaneState {
  const entry = devices.get(deviceId)
  return entry ? derivePlane(entry, at) : "disconnected"
}

export function setDeviceAttention(deviceId: string, attention: DeviceAttention, at: number): void {
  const entry = record(deviceId)
  entry.attention = attention
  entry.lastSeenAt = Math.max(entry.lastSeenAt, at)
}

export function devicePresence(deviceId: string, at: number = Date.now()): DevicePresence | null {
  const entry = devices.get(deviceId)
  if (!entry) return null
  return {
    deviceId: entry.deviceId,
    lastSeenAt: entry.lastSeenAt,
    eventPlane: derivePlane(entry, at),
    attention: entry.attention,
    streams: Array.from(entry.streams.values()).sort((a, b) => a.openedAt - b.openedAt),
  }
}

/**
 * Coarse label for the paired-devices UI.
 *
 * **Deliberately dormant.** No surface renders it yet — the paired-devices card
 * still shows Dexie's durable `lastSeenAt` — so this and {@link devicePresence}
 * are read only by their own tests. They stay because they are the read side of
 * state this module already maintains for control decisions, and because the
 * alternative (a UI deriving presence from `streams` itself) would be a second
 * definition of "online". Pinned by the `presenceLabel` / `devicePresence`
 * suites so their absence from production stays a choice rather than a
 * regression.
 */
export function presenceLabel(deviceId: string, at: number): PresenceLabel {
  const entry = devices.get(deviceId)
  if (!entry) return "offline"
  if (entry.streams.size > 0) return "online"
  if (at - entry.lastSeenAt <= RECENTLY_ACTIVE_WINDOW_MS) return "recently-active"
  return "offline"
}

/**
 * Take (or upgrade) an attachment on `sessionId`.
 *
 * A control lease requires a live event stream — `eventStreamLeaseId` must name
 * a connection this device currently holds. Granting control to a device that
 * cannot hear the run it is steering is the failure this check exists to stop;
 * the caller is expected to have already checked the device's capability grant.
 */
export function attachSessionLease(input: {
  sessionId: string
  deviceId: string
  mode: AttachMode
  eventStreamLeaseId: string
  at: number
}): AttachLease {
  const { sessionId, deviceId, mode, eventStreamLeaseId, at } = input
  if (!sessionId) throw new Error("presence_attach_session_required")
  if (!deviceId) throw new Error("presence_attach_device_required")
  // Lapsed leases are dropped here rather than on a timer. Every attached
  // client re-attaches once per renew interval, so this runs regularly for as
  // long as anything is attached — and when nothing is, there is nothing left
  // to accumulate. Reading them out with a filter (which is all the accessors
  // did) left one entry per (session, device) pair in the map forever.
  sweepExpiredLeases(at)
  const entry = devices.get(deviceId)
  if (!entry || !entry.streams.has(eventStreamLeaseId)) {
    throw new Error("presence_attach_event_plane_required")
  }
  if (mode === "control" && entry.streams.get(eventStreamLeaseId)?.state !== "ready") {
    // A stream that is still replaying has not shown this device the run it
    // would be steering. Bound to it, a control lease would let a phone answer
    // a prompt whose preceding tool calls it has not received.
    throw new Error("presence_attach_stream_not_ready")
  }
  entry.lastSeenAt = Math.max(entry.lastSeenAt, at)

  let perSession = attachments.get(sessionId)
  if (!perSession) {
    perSession = new Map()
    attachments.set(sessionId, perSession)
  }
  const previous = perSession.get(deviceId)
  const lease: AttachLease = {
    sessionId,
    deviceId,
    mode,
    eventStreamLeaseId,
    expiresAt: at + ATTACH_LEASE_TTL_MS,
    attachedAt: previous?.attachedAt ?? at,
  }
  perSession.set(deviceId, lease)
  return lease
}

/**
 * Extend an existing lease. Returns null when there is nothing to renew —
 * either it was never taken or it already lapsed, and in both cases the client
 * must re-attach rather than silently resurrecting authority.
 */
export function renewSessionLease(input: {
  sessionId: string
  deviceId: string
  at: number
}): AttachLease | null {
  const lease = attachments.get(input.sessionId)?.get(input.deviceId)
  if (!lease || lease.expiresAt <= input.at) return null
  lease.expiresAt = input.at + ATTACH_LEASE_TTL_MS
  noteDeviceSeen(input.deviceId, input.at)
  return lease
}

/** The device's live lease on `sessionId`, or null when it holds none. */
export function sessionLeaseFor(
  sessionId: string,
  deviceId: string,
  at: number
): AttachLease | null {
  const lease = attachments.get(sessionId)?.get(deviceId)
  return lease && lease.expiresAt > at ? lease : null
}

export function releaseSessionLease(sessionId: string, deviceId: string): void {
  const perSession = attachments.get(sessionId)
  if (!perSession) return
  perSession.delete(deviceId)
  pruneEmptySessions()
}

/**
 * Drop every attachment held by `deviceId`, across all sessions.
 *
 * Called on device-level loss — the socket dropped, the pairing was revoked,
 * the control grant was withdrawn. The equivalent on the old map existed but
 * was never called from anywhere, which is how attachments outlived the devices
 * that took them.
 */
export function releaseDevice(deviceId: string): void {
  for (const perSession of attachments.values()) perSession.delete(deviceId)
  pruneEmptySessions()
  devices.delete(deviceId)
}

/** Live (unexpired) leases on `sessionId`, in attach order. */
export function sessionLeases(sessionId: string, at: number): AttachLease[] {
  const perSession = attachments.get(sessionId)
  if (!perSession) return []
  return Array.from(perSession.values())
    .filter((lease) => lease.expiresAt > at)
    .sort((a, b) => a.attachedAt - b.attachedAt)
}

/** True when at least one device still holds a live lease on `sessionId`, of
 *  either mode. Presence, not authority — see {@link hasControlLease}. */
export function isSessionAttached(sessionId: string, at: number): boolean {
  return sessionLeases(sessionId, at).length > 0
}

/**
 * True when some device holds a live **control** lease on `sessionId`.
 *
 * This, not {@link isSessionAttached}, is the question the approval router
 * asks: a prompt held open for a watcher who cannot answer it stalls the turn
 * until the backstop denies. Deliberately looser than
 * {@link effectiveController} — a controller whose stream is mid-reconnect gets
 * its prompt when the frames replay, and auto-denying during a few seconds of
 * network churn would be worse than waiting.
 */
export function hasControlLease(sessionId: string, at: number): boolean {
  return sessionLeases(sessionId, at).some((lease) => lease.mode === "control")
}

export function attachedDeviceIds(sessionId: string, at: number): string[] {
  return sessionLeases(sessionId, at).map((lease) => lease.deviceId)
}

/**
 * The single device entitled to act on `sessionId` right now.
 *
 * Requires all four of: a live control lease, the event stream that lease named
 * still open, that stream `ready` (not connecting, replaying, or degraded), and
 * — when several devices qualify — the earliest attachment wins, so a second
 * phone opening the same session cannot silently steal the steering wheel.
 *
 * Returns null while a controller is merely reconnecting. The lease survives to
 * its TTL so the device gets its authority back without a re-attach, but during
 * the gap nobody holds effective control.
 */
export function effectiveController(sessionId: string, at: number): string | null {
  for (const lease of sessionLeases(sessionId, at)) {
    if (lease.mode !== "control") continue
    const entry = devices.get(lease.deviceId)
    // The BOUND stream must be ready, not merely some stream of this device's.
    // Checking the device aggregate would hand control back to a phone whose
    // attachment names a socket that is still draining backlog, on the strength
    // of a second connection the attachment has nothing to do with.
    if (entry?.streams.get(lease.eventStreamLeaseId)?.state !== "ready") continue
    return lease.deviceId
  }
  return null
}

/**
 * Devices that should receive an out-of-band "this run needs you" push.
 *
 * Narrower than "every paired device" in three ways, each deliberate:
 * - Only **control** leases. Telling an observer that input is needed is noise
 *   it cannot act on.
 * - Only **live** leases, including ones whose event stream is down — that
 *   reconnecting device is exactly the one that cannot be reached in-band and
 *   therefore the one a push is for.
 * - Not a device that is **foreground with a ready stream**: it already has the
 *   frame on screen, and a native alert on top of it is a duplicate.
 */
export function notifiableControllers(sessionId: string, at: number): string[] {
  const targets: string[] = []
  for (const lease of sessionLeases(sessionId, at)) {
    if (lease.mode !== "control") continue
    const entry = devices.get(lease.deviceId)
    const inBand =
      entry !== undefined && derivePlane(entry, at) === "ready" && entry.attention === "foreground"
    if (inBand) continue
    targets.push(lease.deviceId)
  }
  return targets
}

/**
 * Drop every lapsed lease, and every device record nothing refers to any more.
 *
 * Called from {@link attachSessionLease}, so it runs on each client's renewal
 * rather than needing a scheduler of its own. The device pass matters as much
 * as the lease pass: `record()` creates an entry for any device that is merely
 * *seen*, and {@link releaseDevice} was the only thing that ever removed one.
 */
export function sweepExpiredLeases(at: number): number {
  let dropped = 0
  for (const perSession of attachments.values()) {
    for (const [deviceId, lease] of perSession) {
      if (lease.expiresAt <= at) {
        perSession.delete(deviceId)
        dropped += 1
      }
    }
  }
  pruneEmptySessions()
  for (const [deviceId, entry] of devices) {
    // Anything still streaming, still attached, or recently enough seen to show
    // in the UI is live state, not garbage.
    if (entry.streams.size > 0) continue
    if (at - entry.lastSeenAt <= RECENTLY_ACTIVE_WINDOW_MS) continue
    if (hasAnyLease(deviceId)) continue
    devices.delete(deviceId)
  }
  return dropped
}

function hasAnyLease(deviceId: string): boolean {
  for (const perSession of attachments.values()) {
    if (perSession.has(deviceId)) return true
  }
  return false
}

function pruneEmptySessions(): void {
  for (const [sessionId, perSession] of attachments) {
    if (perSession.size === 0) attachments.delete(sessionId)
  }
}

/** Test-only — wipe all presence and lease state. */
export function __resetDevicePresenceForTests(): void {
  devices.clear()
  attachments.clear()
}
