import { useCallback, useEffect, useId, useMemo, useSyncExternalStore } from "react"
import { setComputerUsePipAlwaysHidden } from "./computer-use-pip"
import { sandboxClient, type SandboxStreamGrant } from "./sandbox-client"

let preferenceLoad: Promise<void> | null = null
/** Settings are global; concurrent previews share the same read. */
export function loadComputerUsePipPreference(
  load: () => Promise<{ alwaysHidePictureInPicture: boolean }>
): Promise<void> {
  preferenceLoad ??= load()
    .then((settings) => {
      setComputerUsePipAlwaysHidden(settings.alwaysHidePictureInPicture)
    })
    .catch(() => undefined)
  return preferenceLoad
}

const clockListeners = new Set<() => void>()
let now = 0
let clock: ReturnType<typeof setInterval> | null = null
function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  now = Date.now()
  clock ??= setInterval(() => {
    now = Date.now()
    for (const notify of clockListeners) notify()
  }, 1000)
  return () => {
    clockListeners.delete(listener)
    if (!clockListeners.size && clock) {
      clearInterval(clock)
      clock = null
    }
  }
}
const noopSubscribe = () => () => {}
export function useComputerUsePipClock(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribeClock : noopSubscribe,
    () => now,
    () => 0
  )
}

const streamListeners = new Set<() => void>()
const requests = new Map<string, { connectionId: string; priority: boolean; sequence: number }>()
let winners = new Set<string>()
let sequence = 0
export const COMPUTER_USE_PIP_STREAM_LIMIT = 2

interface StreamRequest {
  owner: string
  connectionId: string
  resolve: (grant: SandboxStreamGrant) => void
  reject: (error: unknown) => void
}
interface StreamReservation {
  request: StreamRequest
  grant?: SandboxStreamGrant
  cancelled?: boolean
  closing?: Promise<void>
  retry?: ReturnType<typeof setTimeout>
  attempts: number
}
const waiting: StreamRequest[] = []
const reservations = new Set<StreamReservation>()
function pumpStreams() {
  for (
    let index = 0;
    index < waiting.length && reservations.size < COMPUTER_USE_PIP_STREAM_LIMIT;
  ) {
    const request = waiting[index]!
    if ([...reservations].some((item) => item.request.connectionId === request.connectionId)) {
      index++
      continue
    }
    waiting.splice(index, 1)
    const reservation: StreamReservation = { request, attempts: 0 }
    reservations.add(reservation)
    void sandboxClient
      .streamOpen(request.connectionId)
      .then(async (grant) => {
        reservation.grant = grant
        if (reservation.cancelled) {
          await closeReservation(reservation).catch(() => undefined)
          request.reject(new Error("PiP stream request cancelled"))
        } else request.resolve(grant)
      })
      .catch((error) => {
        reservations.delete(reservation)
        request.reject(error)
        pumpStreams()
      })
  }
}
function closeReservation(reservation: StreamReservation): Promise<void> {
  if (reservation.closing) return reservation.closing
  if (!reservation.grant) return Promise.resolve()
  if (reservation.retry) clearTimeout(reservation.retry)
  reservation.retry = undefined
  reservation.closing = sandboxClient
    .streamClose(reservation.request.connectionId, reservation.grant.viewerId)
    .then(() => {
      reservations.delete(reservation)
      pumpStreams()
    })
    .catch((error) => {
      // An unconfirmed close still occupies capacity. Retry without allowing
      // another decoder/grant to overlap this target in the meantime.
      reservation.retry = setTimeout(
        () => {
          reservation.retry = undefined
          void closeReservation(reservation).catch(() => undefined)
        },
        Math.min(30_000, 1000 * 2 ** Math.min(reservation.attempts++, 5))
      )
      if (typeof reservation.retry === "object") reservation.retry.unref?.()
      throw error
    })
    .finally(() => {
      reservation.closing = undefined
    })
  return reservation.closing
}

/** Transport permits survive hook handoff until the Host confirms close. */
export function createComputerUsePipStreamTransport(owner: string) {
  return {
    open: (connectionId: string) =>
      new Promise<SandboxStreamGrant>((resolve, reject) => {
        waiting.push({ owner, connectionId, resolve, reject })
        pumpStreams()
      }),
    close: async (connectionId: string, viewerId: string) => {
      const reservation = [...reservations].find(
        (item) => item.request.connectionId === connectionId && item.grant?.viewerId === viewerId
      )
      if (reservation) await closeReservation(reservation)
      else await sandboxClient.streamClose(connectionId, viewerId)
    },
    cancel: () => {
      for (let index = waiting.length - 1; index >= 0; index--)
        if (waiting[index]!.owner === owner)
          waiting.splice(index, 1)[0]!.reject(new Error("PiP stream request cancelled"))
      for (const item of reservations)
        if (item.request.owner === owner && !item.grant) item.cancelled = true
    },
  }
}

export function useComputerUsePipStreamTransport(enabled: boolean, connectionId: string) {
  const owner = useId()
  const transport = useMemo(() => createComputerUsePipStreamTransport(owner), [owner])
  useEffect(() => {
    if (!enabled) transport.cancel()
    return transport.cancel
  }, [enabled, connectionId, transport])
  return transport
}
function arbitrateStreams() {
  const next = new Set<string>(),
    targets = new Set<string>()
  const ordered = [...requests].sort(
    (a, b) => Number(b[1].priority) - Number(a[1].priority) || a[1].sequence - b[1].sequence
  )
  for (const [id, request] of ordered) {
    if (targets.has(request.connectionId) || targets.size >= COMPUTER_USE_PIP_STREAM_LIMIT) continue
    targets.add(request.connectionId)
    next.add(id)
  }
  if (next.size === winners.size && [...next].every((id) => winners.has(id))) return
  winners = next
  for (const listener of streamListeners) listener()
}

/** Other views keep their screenshot; granting a slot never acquires desktop control. */
export function useComputerUsePipStreamSlot(
  connectionId: string,
  enabled: boolean,
  priority = false
): boolean {
  const id = useId()
  const allowed = useSyncExternalStore(
    useCallback((listener) => {
      streamListeners.add(listener)
      return () => streamListeners.delete(listener)
    }, []),
    () => winners.has(id),
    () => false
  )
  useEffect(() => {
    if (!enabled) return
    requests.set(id, { connectionId, priority, sequence: sequence++ })
    arbitrateStreams()
    return () => {
      requests.delete(id)
      arbitrateStreams()
    }
  }, [connectionId, enabled, id, priority])
  return enabled && allowed
}

/** Isolated tests reset their module-scoped resource owners. */
export function resetComputerUsePipResources(): void {
  preferenceLoad = null
  if (clock) clearInterval(clock)
  clock = null
  now = 0
  clockListeners.clear()
  requests.clear()
  winners = new Set()
  sequence = 0
  for (const listener of streamListeners) listener()
  for (const request of waiting.splice(0)) request.reject(new Error("PiP resources reset"))
  for (const reservation of reservations) if (reservation.retry) clearTimeout(reservation.retry)
  reservations.clear()
}
