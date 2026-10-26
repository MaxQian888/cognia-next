/** Offline IPC port for frontend tests; native controller tests own concurrency proof. */
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type {
  GoogleConnectionState,
  GoogleStateInput,
  GoogleStatePort,
  GoogleStateReply,
} from "@/lib/docs-providers/providers/google/state"
export const GOOGLE_STATE_KEY = "google-connection-v1"
export function createGoogleDocsTestHost(store: KeyringStore) {
  let serial = 0
  const nonce = () => `fixture-generation-${++serial}`
  let queue: Promise<unknown> = Promise.resolve()
  let cancelled = false
  const revocations = new Set<Promise<unknown>>()
  const observers = new Set<() => void>()
  const read = async (): Promise<GoogleConnectionState> => {
    const raw = await store.load(GOOGLE_STATE_KEY)
    if (raw) {
      const state = JSON.parse(raw)
      if (state.version !== 1) throw new Error("unsupported Google connection record")
      return state
    }
    const parse = async (key: string) => {
      try {
        return JSON.parse((await store.load(key)) ?? "null")
      } catch {
        return null
      }
    }
    const token = await parse("google-tokens")
    const pending = await parse("google-oauth-pending")
    const state: GoogleConnectionState = {
      version: 1,
      connection: nonce(),
      authorization: nonce(),
      claimed: false,
      tokens:
        token && typeof token.accessToken === "string" && typeof token.expiresAt === "number"
          ? {
              accessToken: token.accessToken,
              expiresAt: token.expiresAt,
              refreshToken: typeof token.refreshToken === "string" ? token.refreshToken : undefined,
              scope: typeof token.scope === "string" ? token.scope : undefined,
              tokenType: typeof token.tokenType === "string" ? token.tokenType : undefined,
            }
          : null,
      pending:
        pending &&
        typeof pending.state === "string" &&
        typeof pending.ts === "number" &&
        typeof pending.codeVerifier === "string" &&
        typeof pending.redirectUri === "string"
          ? pending
          : null,
      accountEmail: null,
      legacyMetadata: Boolean(token),
    }
    await write(state)
    return state
  }
  const write = async (state: GoogleConnectionState) => {
    await store.save(GOOGLE_STATE_KEY, JSON.stringify(state))
    await store.delete("google-tokens").catch(() => undefined)
    await store.delete("google-oauth-pending").catch(() => undefined)
  }
  const forget = (state: GoogleConnectionState) => {
    state.connection = nonce()
    state.authorization = nonce()
    state.tokens = null
    state.pending = null
    state.claimed = false
    state.accountEmail = null
    state.legacyMetadata = false
  }
  const transaction = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.catch(() => undefined)
    return result
  }
  const apply = async (input: GoogleStateInput, capture?: (state: GoogleConnectionState) => void) =>
    transaction(async () => {
      const state = await read()
      let pending = null
      switch (input.action) {
        case "snapshot":
          if (cancelled) forget(state)
          return { state, pending: null, outcome: null }
        case "begin":
          if (cancelled) forget(state)
          state.authorization = nonce()
          state.pending = null
          state.claimed = false
          break
        case "setPending":
          if (cancelled || input.authorization !== state.authorization)
            throw new Error("google_docs_state_stale")
          state.pending = input.pending
          state.claimed = false
          break
        case "claim":
          if (cancelled) throw new Error("google_docs_state_stale")
          if (
            !state.pending ||
            state.pending.state !== input.state ||
            input.now - state.pending.ts > 600_000
          )
            throw new Error("google_docs_state_mismatch")
          pending = state.pending
          state.pending = null
          state.claimed = true
          break
        case "commit":
          if (cancelled || input.authorization !== state.authorization || !state.claimed)
            throw new Error("google_docs_state_stale")
          if (!input.tokens.accessToken.trim()) throw new Error("invalid Google access token")
          state.authorization = nonce()
          state.connection = nonce()
          state.tokens = input.tokens
          state.claimed = false
          state.accountEmail = input.accountEmail ?? null
          state.legacyMetadata = false
          break
        case "refresh":
          if (cancelled || input.connection !== state.connection || !state.tokens)
            throw new Error("google_docs_state_stale")
          if (!input.tokens.accessToken.trim()) throw new Error("invalid Google access token")
          state.tokens = input.tokens
          state.connection = nonce()
          break
        case "invalidate":
          if (cancelled || input.connection !== state.connection)
            throw new Error("google_docs_state_stale")
          state.tokens = null
          state.connection = nonce()
          state.accountEmail = null
          state.legacyMetadata = false
          break
        case "disconnect":
          capture?.(state)
          forget(state)
          break
      }
      await write(state)
      if (input.action === "begin") cancelled = false
      for (const observer of observers) observer()
      return { state, pending, outcome: null }
    })
  const host = {
    revoke: async (_token: string): Promise<{ revoked: boolean; reason?: string }> => ({
      revoked: true,
    }),
    subscribe(observer: () => void) {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    },
    call: null as unknown as GoogleStatePort,
  }
  host.call = (input) => {
    if (input.action === "disconnect") {
      cancelled = true
      const work = (async (): Promise<GoogleStateReply> => {
        let token: string | undefined
        const reply = await apply(input, (state) => {
          token = state.tokens?.refreshToken ?? state.tokens?.accessToken
        })
        const outcome = token
          ? await host
              .revoke(token)
              .catch((error: unknown) => ({ revoked: false, reason: String(error) }))
          : { revoked: false, reason: "not-connected" }
        return {
          ...reply,
          outcome: outcome.revoked
            ? { revoked: true }
            : { revoked: false, reason: outcome.reason ?? "revocation failed" },
        }
      })()
      revocations.add(work)
      void work.then(
        () => revocations.delete(work),
        () => revocations.delete(work)
      )
      return work
    }
    if (input.action === "setPending" || input.action === "begin")
      return Promise.allSettled([...revocations]).then(() => apply(input))
    return apply(input)
  }
  return host
}
