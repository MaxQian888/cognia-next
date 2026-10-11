/**
 * A paired phone's live copy of the desktop's glance build (ADR-0225 §9).
 *
 * One store per app. While anything on the phone shows a host-sourced module
 * (the Glance drawer is open, or the home screen shows a pinned one), the
 * store holds a lease on the desktop: it announces the phone's demand with
 * `glance_subscribe`, renews it every 20 s, and takes each snapshot the
 * desktop pushes on `glance://update`. When nothing shows one, it ends the
 * lease and the desktop stops building. Same lease rules as the tray panel's.
 *
 * The last snapshot is kept when the lease ends or the host drops, so a
 * reopened drawer or an offline phone shows the last reading, labelled with
 * how old it is, instead of an empty module. It lives in memory only.
 *
 * Every refusal is a state the modules can say in place: `unsupported` (the
 * host is a headless brain, or too old to serve glance), `unavailable` (the
 * desktop's main window is not up yet; retried on the next renewal), `offline`
 * (the call did not reach the host).
 */

import { DEFAULT_LOCAL_ACCOUNT_ID } from "@/lib/accounts/active-account-id"
import { companionCredentialBook } from "@/lib/companion/credential-book"
import { isGlanceSnapshot, isNewerSnapshot, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { transport } from "@/lib/tauri"
import { hydrateCompanionConfig } from "@/lib/tauri/transport-companion"

import { GLANCE_REMOTE_COMMANDS, GLANCE_UPDATE_EVENT } from "./commands"
import { isGlanceRemoteResult, isGlanceSubscribeResponse, type GlanceRemoteDemand } from "./types"

/** How often a held lease is renewed. A third of the desktop's TTL. */
export const GLANCE_PHONE_RENEW_MS = 20_000
/** How soon a refused or failed announcement is tried again. */
export const GLANCE_PHONE_RETRY_MS = 5_000

export type GlancePhoneStatus =
  /** No lease wanted. */
  | "idle"
  /** Announced; no snapshot received since. */
  | "connecting"
  /** Holding a lease and receiving snapshots. */
  | "live"
  /** The desktop answered, but its publisher is not running yet. */
  | "unavailable"
  /** The host does not serve glance (a headless brain, or an older desktop). */
  | "unsupported"
  /** The call did not reach the host. */
  | "offline"

export interface GlancePhoneState {
  status: GlancePhoneStatus
  /** The newest snapshot ever received from this host, kept across drops. */
  snapshot: GlanceSnapshotV1 | null
  /** When `snapshot` arrived on this phone. */
  receivedAt: number | null
  /** The host's name as it was paired (`CompanionHostRecord.label`). */
  hostLabel: string | null
}

const IDLE: GlancePhoneState = { status: "idle", snapshot: null, receivedAt: null, hostLabel: null }

export interface GlancePhoneDeps {
  call: <T>(command: string, payload: Record<string, unknown>) => Promise<T>
  subscribe: <T>(event: string, handler: (payload: T) => void) => () => void
  hydrate: () => Promise<unknown>
  hostLabel: () => Promise<string | null>
  now: () => number
  consumer: string
}

function newConsumerId(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === "function")
    return `phone-${cryptoApi.randomUUID()}`
  return `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function defaultDeps(): GlancePhoneDeps {
  return {
    call: (command, payload) => transport.call(command, payload),
    subscribe: (event, handler) => transport.subscribe(event, handler),
    hydrate: () => hydrateCompanionConfig(),
    hostLabel: async () =>
      (await companionCredentialBook().getActive(DEFAULT_LOCAL_ACCOUNT_ID))?.label ?? null,
    now: Date.now,
    consumer: newConsumerId(),
  }
}

/** Map a desktop refusal or a failed call to the `glance.errors.*` key a module shows. */
export function glancePhoneErrorKey(code: string | null): string {
  if (code === null) return "errors.hostUnreachable"
  if (code.startsWith("errors.")) return code
  if (code === "headless_host" || code === "glance_unavailable") return "errors.hostUnavailable"
  return "errors.requestFailed"
}

export class GlancePhoneStore {
  private state: GlancePhoneState = IDLE
  private readonly listeners = new Set<() => void>()
  private holders = 0
  private demand: GlanceRemoteDemand | null = null
  private demandKey = ""
  private timer: ReturnType<typeof setTimeout> | null = null
  private detachEvent: (() => void) | null = null
  /**
   * True from `start()` until the event is attached. A second hold or a
   * `setDemand` in that window (the hook holds, then sets the same demand,
   * in one commit) must not start again: that would subscribe twice and leak
   * the first listener.
   */
  private starting = false
  /** Bumped on every stop, so a call that started under an earlier lease is ignored. */
  private generation = 0
  private depsCache: GlancePhoneDeps | null = null

  constructor(private readonly makeDeps: () => GlancePhoneDeps = defaultDeps) {}

  private get deps(): GlancePhoneDeps {
    if (!this.depsCache) this.depsCache = this.makeDeps()
    return this.depsCache
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): GlancePhoneState => this.state

  /**
   * Want a lease for `demand` until the returned release is called. Holders
   * share one lease; the newest demand wins (every holder passes the same
   * one, derived from the phone's single layout).
   */
  hold(demand: GlanceRemoteDemand): () => void {
    this.holders += 1
    this.setDemand(demand)
    let released = false
    return () => {
      if (released) return
      released = true
      this.holders -= 1
      if (this.holders === 0) this.stop()
    }
  }

  /** Change the demand of a held lease; re-announces at once when it differs. */
  setDemand(demand: GlanceRemoteDemand): void {
    const key = JSON.stringify(demand)
    const changed = key !== this.demandKey
    this.demand = demand
    this.demandKey = key
    if (this.holders === 0) return
    if (this.detachEvent === null) {
      // While starting, the announcement at the end of `start()` reads the
      // newest demand, so a change in the meantime needs nothing more.
      if (!this.starting) this.start()
    } else if (changed) this.announceNow()
  }

  /** Ask the desktop to refresh. Resolves to null or a `glance.errors.*` key. */
  async request(
    body:
      | { kind: "refresh" }
      | { kind: "quota-refresh"; key: string }
      | {
          kind: "quota-enable"
          provider: string
          accountId: string
        }
  ): Promise<string | null> {
    try {
      const result =
        body.kind === "quota-enable"
          ? await this.deps.call<unknown>(GLANCE_REMOTE_COMMANDS.quotaEnable, {
              provider: body.provider,
              accountId: body.accountId,
            })
          : await this.deps.call<unknown>(GLANCE_REMOTE_COMMANDS.request, {
              consumer: this.deps.consumer,
              ...body,
            })
      if (!isGlanceRemoteResult(result)) return "errors.requestFailed"
      return result.ok ? null : glancePhoneErrorKey(result.code)
    } catch {
      return glancePhoneErrorKey(null)
    }
  }

  /** Test seam: drop everything, including the kept snapshot. */
  reset(): void {
    this.stop()
    this.holders = 0
    this.demand = null
    this.demandKey = ""
    this.state = IDLE
    this.depsCache = null
    this.emit()
  }

  private start(): void {
    const generation = this.generation
    this.starting = true
    this.patch({ status: "connecting" })
    void (async () => {
      // A cold start can mount before the companion boot has filled the
      // transport's config cache; without it the subscribe frame and the call
      // both fail and the phone would report a working host as offline.
      try {
        await this.deps.hydrate()
      } catch {
        // The call below reports what actually happened.
      }
      // A stop in the meantime bumped the generation and cleared `starting`;
      // a newer start owns the flag now, so leave it alone.
      if (generation !== this.generation) return
      this.starting = false
      if (this.holders === 0) return
      // Subscribe before announcing, so the first push cannot fall into a gap.
      this.detachEvent = this.deps.subscribe<unknown>(GLANCE_UPDATE_EVENT, (payload) => {
        if (generation !== this.generation) return
        this.accept(payload)
      })
      void this.deps
        .hostLabel()
        .then((hostLabel) => {
          if (generation === this.generation && hostLabel !== this.state.hostLabel) {
            this.patch({ hostLabel })
          }
        })
        .catch(() => {})
      this.announceNow()
    })()
  }

  private stop(): void {
    this.generation += 1
    this.starting = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const hadLease = this.detachEvent !== null
    this.detachEvent?.()
    this.detachEvent = null
    if (hadLease && this.demand) {
      // Best effort: a lease that is not ended lapses on the desktop anyway.
      void this.deps
        .call(GLANCE_REMOTE_COMMANDS.subscribe, {
          consumer: this.deps.consumer,
          visible: false,
          demand: this.demand,
        })
        .catch(() => {})
    }
    if (this.state.status !== "idle") this.patch({ status: "idle" })
  }

  private announceNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const generation = this.generation
    const demand = this.demand
    if (!demand) return
    void this.deps
      .call<unknown>(GLANCE_REMOTE_COMMANDS.subscribe, {
        consumer: this.deps.consumer,
        visible: true,
        demand,
      })
      .then((response) => {
        if (generation !== this.generation) return
        if (!isGlanceSubscribeResponse(response)) {
          this.patch({ status: "unavailable" })
          this.schedule(GLANCE_PHONE_RETRY_MS)
          return
        }
        if (!response.ok) {
          if (response.code === "headless_host") {
            // Not a transient state: a brain never builds glance. Hold no
            // lease and stop renewing; the next hold (another host, a new
            // pairing) tries again.
            this.patch({ status: "unsupported" })
            return
          }
          this.patch({ status: "unavailable" })
          this.schedule(GLANCE_PHONE_RETRY_MS)
          return
        }
        if (response.snapshot !== null) this.accept(response.snapshot)
        else if (this.state.status !== "live") this.patch({ status: "connecting" })
        this.schedule(Math.min(GLANCE_PHONE_RENEW_MS, Math.max(1_000, response.ttlMs / 3)))
      })
      .catch(() => {
        if (generation !== this.generation) return
        this.patch({ status: "offline" })
        this.schedule(GLANCE_PHONE_RETRY_MS)
      })
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.holders > 0) this.announceNow()
    }, ms)
  }

  private accept(payload: unknown): void {
    if (!isGlanceSnapshot(payload)) return
    if (this.state.snapshot && !isNewerSnapshot(this.state.snapshot, payload)) {
      if (this.state.status !== "live") this.patch({ status: "live" })
      return
    }
    this.patch({ status: "live", snapshot: payload, receivedAt: this.deps.now() })
  }

  private patch(next: Partial<GlancePhoneState>): void {
    this.state = { ...this.state, ...next }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const glancePhoneStore = new GlancePhoneStore()
