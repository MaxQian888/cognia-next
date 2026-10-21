import { CODE_TTL_SECONDS, renderEmail, type MailInput } from "./template"
import type { Env } from "./index"

export const SEND_TIMEOUT_MS = 8_000
const HOUR_MS = 3_600_000
const COOLDOWN_MS = 60_000
const MAX_HOURLY_SENDS = 10
const STATE_KEY = "delivery"

type Delivery = { status: "pending" | "accepted" | "uncertain"; expiresAt: number }
export interface StoredState {
  attempts: number[]
  deliveries: Record<string, Delivery>
}

/** Structural subset of the SQLite Durable Object storage API. */
export interface DeliveryStorage {
  get(key: string): Promise<StoredState | undefined>
  put(key: string, value: StoredState): Promise<void>
  transaction<T>(callback: (store: DeliveryStorage) => Promise<T>): Promise<T>
  setAlarm(time: number): Promise<void>
  deleteAll(): Promise<void>
}

interface State {
  storage: DeliveryStorage
  waitUntil(promise: Promise<unknown>): void
}

type Input = MailInput & { digest: string }
type Outcome = { status: number; retryAfter?: number; duplicate?: boolean }

function reply(outcome: Outcome): Response {
  return new Response(
    outcome.status === 200
      ? "Accepted"
      : outcome.status === 429
        ? "Try again later"
        : "Email delivery failed",
    {
      status: outcome.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-cognia-mail-status":
          outcome.status === 200 ? (outcome.duplicate ? "duplicate" : "accepted") : "deferred",
        ...(outcome.retryAfter ? { "retry-after": String(outcome.retryAfter) } : {}),
      },
    }
  )
}

/** One object per keyed recipient digest; independent recipients never share a lock. */
export class EmailDelivery {
  private readonly inFlight = new Map<string, Promise<Outcome>>()

  constructor(
    private readonly ctx: State,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Only the authenticated Worker can access this binding, with already validated input.
    const input = (await request.json()) as Input
    const existing = this.inFlight.get(input.digest)
    if (existing) return reply({ ...(await existing), duplicate: true })
    const promise = this.deliver(input).catch((): Outcome => ({ status: 503, retryAfter: 60 }))
    this.inFlight.set(input.digest, promise)
    try {
      return reply(await promise)
    } finally {
      this.inFlight.delete(input.digest)
    }
  }

  private async deliver(input: Input): Promise<Outcome> {
    const now = Date.now()
    const reservation = await this.ctx.storage.transaction(
      async (store): Promise<Outcome | null> => {
        const stored = (await store.get(STATE_KEY)) ?? { attempts: [], deliveries: {} }
        const state: StoredState = {
          attempts: stored.attempts.filter((time) => time > now - HOUR_MS),
          deliveries: Object.fromEntries(
            Object.entries(stored.deliveries).filter(([, d]) => d.expiresAt > now)
          ),
        }
        const previous = state.deliveries[input.digest]
        if (previous) {
          return previous.status === "accepted"
            ? { status: 200, duplicate: true }
            : { status: 503, retryAfter: 60 }
        }
        const latest = state.attempts.at(-1)
        if (latest !== undefined && now - latest < COOLDOWN_MS) {
          return { status: 429, retryAfter: Math.ceil((latest + COOLDOWN_MS - now) / 1000) }
        }
        if (state.attempts.length >= MAX_HOURLY_SENDS) {
          return { status: 429, retryAfter: Math.ceil((state.attempts[0] + HOUR_MS - now) / 1000) }
        }
        state.attempts.push(now)
        state.deliveries[input.digest] = {
          status: "pending",
          expiresAt: now + CODE_TTL_SECONDS * 1000,
        }
        await store.put(STATE_KEY, state)
        // SQLite includes alarm writes in this transaction: one durable commit
        // reserves the attempt and guarantees cleanup before provider dispatch.
        await this.ctx.storage.setAlarm(now + HOUR_MS)
        return null
      }
    )
    if (reservation) return reservation

    // Persist the reservation BEFORE calling a provider without an idempotency key.
    // A restart or timeout leaves an uncertain attempt, never permission to resend it.
    const provider = Promise.resolve()
      .then(() => this.env.EMAIL!.send(renderEmail(input, this.env.MAIL_FROM)))
      .then(
        async (result): Promise<Outcome> => {
          if (!result.messageId) {
            await this.mark(input.digest, "uncertain")
            return { status: 502, retryAfter: 60 }
          }
          await this.mark(input.digest, "accepted")
          return { status: 200 }
        },
        async (): Promise<Outcome> => {
          await this.mark(input.digest, "uncertain")
          return { status: 502, retryAfter: 60 }
        }
      )
    // A late success can still update the reservation after the HTTP deadline.
    this.ctx.waitUntil(provider.catch(() => undefined))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ status: 503, retryAfter: 60 }), SEND_TIMEOUT_MS)
    })
    try {
      const outcome = await Promise.race([provider, deadline])
      if (outcome.status === 503) await this.mark(input.digest, "uncertain")
      return outcome
    } finally {
      clearTimeout(timer)
    }
  }

  private async mark(digest: string, status: "accepted" | "uncertain"): Promise<void> {
    await this.ctx.storage.transaction(async (store) => {
      const state = await store.get(STATE_KEY)
      const delivery = state?.deliveries[digest]
      if (!state || !delivery || delivery.expiresAt <= Date.now()) return
      if (status === "uncertain" && delivery.status === "accepted") return
      delivery.status = status
      await store.put(STATE_KEY, state)
    })
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get(STATE_KEY)
    const last = state?.attempts.at(-1)
    if (last !== undefined && last + HOUR_MS > Date.now()) {
      await this.ctx.storage.setAlarm(last + HOUR_MS)
      return
    }
    await this.ctx.storage.deleteAll()
  }
}
