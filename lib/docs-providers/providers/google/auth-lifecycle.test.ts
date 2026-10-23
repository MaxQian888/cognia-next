// Unlike auth.test.ts, these regressions keep the real config and pending storage.
// Only the database, keyring port, and HTTP boundary are replaced.
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsEnsureServer: jest.fn() }))

import { createGoogleDocsTestHost, GOOGLE_STATE_KEY } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "./state"
import type { KeyringStore } from "@/lib/credentials/keyring-store"
import type { AppSettings } from "@cognia/agent-config-types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import {
  __setDocsProviderSecretsForTests,
  saveGoogleClientSecret,
  saveGoogleTokens,
  loadGoogleTokens,
  getGoogleDocsSettings,
} from "./config"
import { getGoogleOAuthPending } from "./oauth-pending"
import {
  beginGoogleDocsAuth,
  disconnectGoogleDocs,
  completeGoogleDocsAuth,
  refreshGoogleTokens,
  getGoogleAccessToken,
} from "./auth"
import type { GoogleHttpFn, GoogleHttpResponse } from "./http"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const NOW = 1000
let pending = {
  state: "google:nonce",
  codeVerifier: "verifier",
  redirectUri: "http://127.0.0.1:7842/oauth/docs/google/callback",
}
const response = (body = "", status = 200): GoogleHttpResponse => ({ status, headers: {}, body })
const revoke: GoogleHttpFn = async () => response()
const exchange: GoogleHttpFn = async ({ url }) =>
  response(
    url.includes("/token")
      ? '{"access_token":"new","refresh_token":"new-rt"}'
      : '{"email":"user@example.test"}'
  )
let host: ReturnType<typeof createGoogleDocsTestHost>
let settings: AppSettings
let beforeTokenSave: (() => Promise<void>) | undefined
let beforeLoad: ((key: string) => Promise<void>) | undefined
let beforeDelete: ((key: string) => Promise<void>) | undefined
let beforeSave: ((key: string, value: string) => Promise<void>) | undefined
let beforeSettingsSave: ((next: AppSettings) => Promise<void>) | undefined

beforeEach(async () => {
  settings = { docsProviders: { google: { clientId: "cid", connected: true } } } as AppSettings
  ;(getSettings as jest.Mock).mockImplementation(async () => settings)
  ;(saveSettings as jest.Mock).mockImplementation(async (input) => {
    const patch = typeof input === "function" ? input(settings) : input
    await beforeSettingsSave?.({ ...settings, ...patch })
    settings = { ...settings, ...patch }
    return settings
  })
  beforeTokenSave = undefined
  beforeLoad = undefined
  beforeDelete = undefined
  beforeSave = undefined
  beforeSettingsSave = undefined
  const values = new Map<string, string>()
  const store: KeyringStore = {
    save: async (key, value) => {
      await beforeSave?.(key, value)
      if (key === GOOGLE_STATE_KEY && JSON.parse(value).tokens?.accessToken === "new")
        await beforeTokenSave?.()
      values.set(key, value)
    },
    load: async (key) => {
      await beforeLoad?.(key)
      return values.get(key) ?? null
    },
    delete: async (key) => {
      await beforeDelete?.(key)
      values.delete(key)
    },
  }
  __setDocsProviderSecretsForTests(store)
  host = createGoogleDocsTestHost(store)
  __setGoogleStatePortForTests(host.call)
  await saveGoogleClientSecret("secret")
})
afterEach(() => {
  __setDocsProviderSecretsForTests(null)
  __setGoogleStatePortForTests(null)
})

async function seedTokens() {
  await saveGoogleTokens({ accessToken: "old", refreshToken: "rt", expiresAt: 0 })
}
async function seedPending() {
  await beginGoogleDocsAuth({ now: () => NOW, ensureServer: async () => "127.0.0.1:7842" })
  pending = (await getGoogleOAuthPending(NOW))!
}

it("marks invalid_grant disconnected and removes revoked credentials", async () => {
  await seedTokens()
  await expect(
    refreshGoogleTokens({ http: async () => response('{"error":"invalid_grant"}', 400) })
  ).rejects.toMatchObject({ code: "notAuthorized" })
  expect((await getGoogleDocsSettings()).connected).toBe(false)
  expect(await loadGoogleTokens()).toBeNull()
  await expect(getGoogleAccessToken()).rejects.toMatchObject({ code: "notConfigured" })
})

it("preserves credentials after a transient refresh failure", async () => {
  await seedTokens()
  await expect(
    refreshGoogleTokens({ http: async () => response("unavailable", 503) })
  ).rejects.toMatchObject({ code: "network" })
  expect((await getGoogleDocsSettings()).connected).toBe(true)
  expect((await loadGoogleTokens())?.accessToken).toBe("old")
})

it("disconnect cancels durable pending auth even when no tokens exist", async () => {
  await seedPending()
  await disconnectGoogleDocs({ http: revoke })
  expect(await getGoogleOAuthPending(NOW)).toBeNull()
  await expect(
    completeGoogleDocsAuth(
      { state: pending.state, code: "code" },
      { now: () => NOW, http: exchange }
    )
  ).rejects.toMatchObject({ code: "notAuthorized" })
  expect((await getGoogleDocsSettings()).connected).toBe(false)
  expect(await loadGoogleTokens()).toBeNull()
})

it("rejects a refresh finishing after disconnect without restoring tokens", async () => {
  await seedTokens()
  const reached = deferred<void>()
  const delayed = deferred<GoogleHttpResponse>()
  const refreshing = refreshGoogleTokens({
    http: async () => {
      reached.resolve()
      return delayed.promise
    },
  })
  const rejected = expect(refreshing).rejects.toMatchObject({ code: "notAuthorized" })
  await reached.promise
  await disconnectGoogleDocs({ http: revoke })
  delayed.resolve(response('{"access_token":"fresh"}'))
  await rejected
  expect(await loadGoogleTokens()).toBeNull()
  expect((await getGoogleDocsSettings()).connected).toBe(false)
  await expect(getGoogleAccessToken()).rejects.toMatchObject({ code: "notConfigured" })
})

it.each(["exchange", "metadata"])("disconnect invalidates a callback during %s", async (phase) => {
  await seedTokens()
  await seedPending()
  const reached = deferred<void>()
  const delayed = deferred<GoogleHttpResponse>()
  const completing = completeGoogleDocsAuth(
    { state: pending.state, code: "code" },
    {
      now: () => NOW,
      http: async (req) => {
        if (req.url.includes("/token") === (phase === "exchange")) {
          reached.resolve()
          return delayed.promise
        }
        return exchange(req)
      },
    }
  )
  const rejected = expect(completing).rejects.toMatchObject({ code: "notAuthorized" })
  await reached.promise
  await disconnectGoogleDocs({ http: revoke })
  delayed.resolve(
    response(phase === "exchange" ? '{"access_token":"late","refresh_token":"rt"}' : "{}")
  )
  await rejected
  expect(await loadGoogleTokens()).toBeNull()
  expect((await getGoogleDocsSettings()).connected).toBe(false)
})

it("clears a token write already in progress before disconnect resolves", async () => {
  await seedPending()
  const reached = deferred<void>()
  const release = deferred<void>()
  beforeTokenSave = async () => {
    reached.resolve()
    await release.promise
  }
  const completing = completeGoogleDocsAuth(
    { state: pending.state, code: "code" },
    { now: () => NOW, http: exchange }
  )
  const rejected = expect(completing).rejects.toMatchObject({ code: "notAuthorized" })
  await reached.promise
  const revoking = jest.fn(async (_token: string) => ({ revoked: true }))
  host.revoke = revoking
  const disconnecting = disconnectGoogleDocs()
  release.resolve()
  await Promise.all([rejected, disconnecting])
  expect(revoking).toHaveBeenCalledWith("new-rt")
  expect(await loadGoogleTokens()).toBeNull()
  expect((await getGoogleDocsSettings()).connected).toBe(false)
})

it.each([response('{"access_token":"stale"}'), response('{"error":"invalid_grant"}', 400)])(
  "a stale refresh cannot overwrite or clear a newly authorized account: %j",
  async (late) => {
    await seedTokens()
    const reached = deferred<void>()
    const delayed = deferred<GoogleHttpResponse>()
    const refreshing = refreshGoogleTokens({
      http: async () => {
        reached.resolve()
        return delayed.promise
      },
    })
    const rejected = expect(refreshing).rejects.toMatchObject({ code: "notAuthorized" })
    await reached.promise
    await seedPending()
    await completeGoogleDocsAuth(
      { state: pending.state, code: "code" },
      { now: () => NOW, http: exchange }
    )
    delayed.resolve(late)
    await rejected
    expect((await loadGoogleTokens())?.accessToken).toBe("new")
    expect((await getGoogleDocsSettings()).connected).toBe(true)
  }
)

it("does not let a mismatched error callback consume the current pending state", async () => {
  await seedPending()
  await expect(
    completeGoogleDocsAuth({ state: "google:other", error: "access_denied" }, { now: () => NOW })
  ).rejects.toMatchObject({ code: "notAuthorized" })
  expect(await getGoogleOAuthPending(NOW)).toMatchObject({ state: pending.state })
})

it("claims a matching callback once before exchanging its code", async () => {
  await seedPending()
  const reached = deferred<void>()
  const delayed = deferred<GoogleHttpResponse>()
  const http: GoogleHttpFn = jest.fn(async ({ url }) => {
    if (url.includes("/token")) {
      reached.resolve()
      return delayed.promise
    }
    return response("{}")
  })
  const completing = completeGoogleDocsAuth(
    { state: pending.state, code: "code" },
    { now: () => NOW, http }
  )
  await reached.promise
  const duplicate = expect(
    completeGoogleDocsAuth({ state: pending.state, code: "code" }, { now: () => NOW, http })
  ).rejects.toMatchObject({ code: "notAuthorized" })
  delayed.resolve(response('{"access_token":"new","refresh_token":"rt"}'))
  await Promise.all([completing, duplicate])
  expect(http).toHaveBeenCalledTimes(2)
})

it("coalesces concurrent refreshes of the same credentials", async () => {
  await seedTokens()
  const http = jest.fn(async () => response('{"access_token":"fresh"}'))
  await Promise.all([refreshGoogleTokens({ http }), refreshGoogleTokens({ http })])
  expect(http).toHaveBeenCalledTimes(1)
})

it("waits for an old revoke before starting a new authorization", async () => {
  await seedTokens()
  const reached = deferred<void>()
  const delayed = deferred<{ revoked: boolean }>()
  host.revoke = async () => {
    reached.resolve()
    return delayed.promise
  }
  const disconnecting = disconnectGoogleDocs()
  await reached.promise
  const ensureServer = jest.fn(async () => "127.0.0.1:7842")
  const beginning = beginGoogleDocsAuth({ ensureServer })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const startedBeforeRevoke = ensureServer.mock.calls.length
  delayed.resolve({ revoked: true })
  await disconnecting
  await beginning
  expect(startedBeforeRevoke).toBe(0)
  expect(ensureServer).toHaveBeenCalledTimes(1)
})

it.each(["load", "save", "pending-delete", "token-delete"])(
  "keeps old callbacks blocked after a %s failure and permits a later reconnect",
  async (port) => {
    await seedTokens()
    await seedPending()
    const failure = new Error(`failed ${port}`)
    if (port === "load")
      beforeLoad = async (key) => {
        if (key === GOOGLE_STATE_KEY) {
          beforeLoad = undefined
          throw failure
        }
      }
    if (port === "save")
      beforeSave = async (key) => {
        if (key === GOOGLE_STATE_KEY) {
          beforeSave = undefined
          throw failure
        }
      }
    if (port.endsWith("delete"))
      beforeDelete = async (key) => {
        if (
          (port === "pending-delete" && key.endsWith("pending")) ||
          (port === "token-delete" && key.endsWith("tokens"))
        ) {
          beforeDelete = undefined
          throw failure
        }
      }
    // The canonical record is one transaction. Legacy cleanup cannot undo its tombstone.
    if (port === "load" || port === "save")
      await expect(disconnectGoogleDocs()).rejects.toThrow(failure)
    else await expect(disconnectGoogleDocs()).resolves.toMatchObject({ revoked: true })
    expect(await getGoogleOAuthPending(NOW)).toBeNull()
    expect(await loadGoogleTokens()).toBeNull()
    expect((await getGoogleDocsSettings()).connected).toBe(false)
    await expect(
      completeGoogleDocsAuth(
        { state: pending.state, code: "stale" },
        { now: () => NOW, http: exchange }
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
    await seedPending()
    await completeGoogleDocsAuth(
      { state: pending.state, code: "new" },
      { now: () => NOW, http: exchange }
    )
    expect((await loadGoogleTokens())?.accessToken).toBe("new")
    expect((await getGoogleDocsSettings()).connected).toBe(true)
  }
)

it.each(["pending", "settings"])("disconnect invalidates a delayed %s commit", async (phase) => {
  const reached = deferred<void>()
  const release = deferred<void>()
  let operation: Promise<unknown>
  if (phase === "pending") {
    beforeSave = async (key, value) => {
      if (key === GOOGLE_STATE_KEY && JSON.parse(value).pending) {
        reached.resolve()
        await release.promise
      }
    }
    operation = beginGoogleDocsAuth({ ensureServer: async () => "127.0.0.1:7842", now: () => NOW })
  } else {
    await seedPending()
    beforeSave = async (key, value) => {
      if (key === GOOGLE_STATE_KEY && JSON.parse(value).accountEmail) {
        reached.resolve()
        await release.promise
      }
    }
    operation = completeGoogleDocsAuth(
      { state: pending.state, code: "code" },
      { now: () => NOW, http: exchange }
    )
  }
  const rejected = expect(operation).rejects.toMatchObject({ code: "notAuthorized" })
  await reached.promise
  const disconnecting = disconnectGoogleDocs({ http: revoke })
  release.resolve()
  await Promise.all([rejected, disconnecting])
  expect(await loadGoogleTokens()).toBeNull()
  expect(await getGoogleOAuthPending(NOW)).toBeNull()
  expect((await getGoogleDocsSettings()).connected).toBe(false)
})

it("a newer begin supersedes an exchanging callback without losing its own pending state", async () => {
  await seedPending()
  const reached = deferred<void>()
  const delayed = deferred<GoogleHttpResponse>()
  const completing = completeGoogleDocsAuth(
    { state: pending.state, code: "old" },
    {
      now: () => NOW,
      http: async () => {
        reached.resolve()
        return delayed.promise
      },
    }
  )
  const rejected = expect(completing).rejects.toMatchObject({ code: "notAuthorized" })
  await reached.promise
  await seedPending()
  const replacement = pending.state
  delayed.resolve(response('{"access_token":"old","refresh_token":"rt"}'))
  await rejected
  expect((await getGoogleOAuthPending(NOW))?.state).toBe(replacement)
  await completeGoogleDocsAuth(
    { state: replacement, code: "new" },
    { now: () => NOW, http: exchange }
  )
  expect((await loadGoogleTokens())?.accessToken).toBe("new")
})

it("a revoked old grant does not cancel a newer pending authorization", async () => {
  await seedTokens()
  const reached = deferred<void>()
  const delayed = deferred<GoogleHttpResponse>()
  const refreshing = refreshGoogleTokens({
    http: async () => {
      reached.resolve()
      return delayed.promise
    },
  })
  const rejected = expect(refreshing).rejects.toMatchObject({ code: "notAuthorized" })
  await reached.promise
  await seedPending()
  delayed.resolve(response('{"error":"invalid_grant"}', 400))
  await rejected
  expect((await getGoogleOAuthPending(NOW))?.state).toBe(pending.state)
  await completeGoogleDocsAuth(
    { state: pending.state, code: "new" },
    { now: () => NOW, http: exchange }
  )
  expect((await getGoogleDocsSettings()).connected).toBe(true)
})

it("waits for every revoke even when another disconnect cleanup fails", async () => {
  await seedTokens()
  const reached = deferred<void>()
  const delayed = deferred<{ revoked: boolean }>()
  host.revoke = async () => {
    reached.resolve()
    return delayed.promise
  }
  const first = disconnectGoogleDocs()
  await reached.promise
  beforeSave = async (key) => {
    if (key === GOOGLE_STATE_KEY) {
      beforeSave = undefined
      throw new Error("second cleanup failed")
    }
  }
  await expect(disconnectGoogleDocs({ http: revoke })).rejects.toThrow("second cleanup failed")
  const ensureServer = jest.fn(async () => "127.0.0.1:7842")
  const beginning = beginGoogleDocsAuth({ ensureServer })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const startedBeforeFirstRevoke = ensureServer.mock.calls.length
  delayed.resolve({ revoked: true })
  await Promise.all([first, beginning])
  expect(startedBeforeFirstRevoke).toBe(0)
  expect(ensureServer).toHaveBeenCalledTimes(1)
})
