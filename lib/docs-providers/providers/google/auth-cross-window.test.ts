// Each client loads a separate module graph, as separate WebViews do.
/* eslint-disable @typescript-eslint/no-require-imports -- isolateModules requires synchronous module loading to create independent renderer realms. */
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(), saveSettings: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsEnsureServer: jest.fn() }))
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import type { AppSettings } from "@cognia/agent-config-types"
import type { GoogleHttpFn, GoogleHttpResponse } from "./http"
import type { GoogleStatePort } from "./state"

type Realm = {
  auth: typeof import("./auth")
  config: typeof import("./config")
  pending: typeof import("./oauth-pending")
}
let settings: AppSettings
let secrets: Map<string, string>
let beforeRecordSave: ((key: string, value: string) => Promise<void>) | undefined
let host: ReturnType<typeof createGoogleDocsTestHost>
const response = (body = "", status = 200): GoogleHttpResponse => ({ status, body, headers: {} })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
function realm(port: GoogleStatePort = host.call): Realm {
  let client!: Realm
  jest.isolateModules(() => {
    const db = require("@/lib/db/settings") as typeof import("@/lib/db/settings")
    ;(db.getSettings as jest.Mock).mockImplementation(async () => settings)
    ;(db.saveSettings as jest.Mock).mockImplementation(async (input) => {
      settings = { ...settings, ...(typeof input === "function" ? input(settings) : input) }
      return settings
    })
    const statePort = require("./state") as typeof import("./state")
    statePort.__setGoogleStatePortForTests(port)
    const config = require("./config") as Realm["config"]
    config.__setDocsProviderSecretsForTests({
      load: async (key) => secrets.get(key) ?? null,
      save: async (key, value) => {
        secrets.set(key, value)
      },
      delete: async (key) => {
        secrets.delete(key)
      },
    })
    client = { config, auth: require("./auth"), pending: require("./oauth-pending") }
  })
  return client
}
const exchange: GoogleHttpFn = async (req) =>
  response(
    req.url.includes("/token")
      ? '{"access_token":"new","refresh_token":"new-rt"}'
      : '{"email":"new@example.test"}'
  )
const revoke: GoogleHttpFn = async () => response()
async function prepare(client: Realm) {
  await client.auth.beginGoogleDocsAuth({ ensureServer: async () => "127.0.0.1:7842" })
  return (await client.pending.getGoogleOAuthPending())!
}
beforeEach(() => {
  settings = { docsProviders: { google: { clientId: "cid", connected: true } } } as AppSettings
  secrets = new Map([
    ["google-client-secret", "fixture-secret"],
    ["google-tokens", JSON.stringify({ accessToken: "old", refreshToken: "rt", expiresAt: 0 })],
  ])
  beforeRecordSave = undefined
  host = createGoogleDocsTestHost({
    load: async (key) => secrets.get(key) ?? null,
    save: async (key, value) => {
      await beforeRecordSave?.(key, value)
      secrets.set(key, value)
    },
    delete: async (key) => {
      secrets.delete(key)
    },
  })
})

it("a refresh from another window cannot restore disconnected credentials", async () => {
  const a = realm(),
    b = realm()
  const entered = deferred<void>(),
    delayed = deferred<GoogleHttpResponse>()
  const refreshing = a.auth.refreshGoogleTokens({
    http: async () => {
      entered.resolve()
      return delayed.promise
    },
  })
  const rejected = expect(refreshing).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  await b.auth.disconnectGoogleDocs({ http: revoke })
  delayed.resolve(response('{"access_token":"stale"}'))
  await rejected
  expect(await a.config.loadGoogleTokens()).toBeNull()
  expect((await a.config.getGoogleDocsSettings()).connected).toBe(false)
})

it("disconnect invalidates an exchanging callback in another window", async () => {
  const a = realm(),
    b = realm()
  const pending = await prepare(a)
  const entered = deferred<void>(),
    delayed = deferred<GoogleHttpResponse>()
  const completing = a.auth.completeGoogleDocsAuth(
    { state: pending.state, code: "code" },
    {
      http: async (req) => {
        if (req.url.includes("/token")) {
          entered.resolve()
          return delayed.promise
        }
        return response("{}")
      },
    }
  )
  const rejected = expect(completing).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  await b.auth.disconnectGoogleDocs({ http: revoke })
  delayed.resolve(response('{"access_token":"stale","refresh_token":"rt"}'))
  await rejected
  expect(await b.config.loadGoogleTokens()).toBeNull()
  expect((await b.config.getGoogleDocsSettings()).connected).toBe(false)
})

it("a stale refresh failure cannot clear a newly authorized account in another window", async () => {
  const a = realm(),
    b = realm()
  const entered = deferred<void>(),
    delayed = deferred<GoogleHttpResponse>()
  const refreshing = a.auth.refreshGoogleTokens({
    http: async () => {
      entered.resolve()
      return delayed.promise
    },
  })
  const rejected = expect(refreshing).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  const pending = await prepare(b)
  await b.auth.completeGoogleDocsAuth({ state: pending.state, code: "new" }, { http: exchange })
  delayed.resolve(response('{"error":"invalid_grant"}', 400))
  await rejected
  expect((await b.config.loadGoogleTokens())?.accessToken).toBe("new")
  expect((await b.config.getGoogleDocsSettings()).connected).toBe(true)
})

it("only one window can claim the same callback", async () => {
  const a = realm(),
    b = realm()
  const pending = await prepare(a)
  const delayed = deferred<GoogleHttpResponse>(),
    entered = deferred<void>()
  const http: GoogleHttpFn = jest.fn(async (req) => {
    if (req.url.includes("/token")) {
      entered.resolve()
      return delayed.promise
    }
    return response("{}")
  })
  const first = a.auth.completeGoogleDocsAuth({ state: pending.state, code: "code" }, { http })
  await entered.promise
  const second = expect(
    b.auth.completeGoogleDocsAuth({ state: pending.state, code: "code" }, { http })
  ).rejects.toMatchObject({ code: "notAuthorized" })
  delayed.resolve(response('{"access_token":"new","refresh_token":"rt"}'))
  await Promise.all([first, second])
  expect(http).toHaveBeenCalledTimes(2)
})

it("a late unrelated singleton save cannot reconnect the authoritative connection", async () => {
  const a = realm(),
    b = realm()
  const stale = structuredClone(settings)
  await a.auth.disconnectGoogleDocs({ http: revoke })
  settings = { ...stale, theme: "dark" }
  expect((await b.config.getGoogleDocsSettings()).connected).toBe(false)
  await expect(b.auth.getGoogleAccessToken()).rejects.toMatchObject({ code: "notConfigured" })
})

it("getAccessToken reuses another window's refresh winner for the same authorization", async () => {
  const a = realm(),
    b = realm()
  const entered = deferred<void>(),
    delayed = deferred<GoogleHttpResponse>()
  const reading = a.auth.getGoogleAccessToken({
    http: async () => {
      entered.resolve()
      return delayed.promise
    },
  })
  await entered.promise
  await b.auth.refreshGoogleTokens({
    http: async () => response('{"access_token":"winner","expires_in":3600}'),
  })
  delayed.resolve(response('{"access_token":"late"}'))
  await expect(reading).resolves.toBe("winner")
  expect((await a.config.loadGoogleTokens())?.accessToken).toBe("winner")
})
it("getAccessToken never substitutes a newly connected account after an old refresh loses", async () => {
  const a = realm(),
    b = realm()
  const entered = deferred<void>(),
    delayed = deferred<GoogleHttpResponse>()
  const reading = a.auth.getGoogleAccessToken({
    http: async () => {
      entered.resolve()
      return delayed.promise
    },
  })
  const rejected = expect(reading).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  await b.auth.disconnectGoogleDocs()
  const pending = await prepare(b)
  await b.auth.completeGoogleDocsAuth({ state: pending.state, code: "new" }, { http: exchange })
  delayed.resolve(response('{"access_token":"late"}'))
  await rejected
  expect((await b.config.loadGoogleTokens())?.accessToken).toBe("new")
})
it("a pending write interrupted by another window's disconnect cannot return a consent URL", async () => {
  const a = realm(),
    b = realm()
  const entered = deferred<void>(),
    release = deferred<void>()
  beforeRecordSave = async (key, value) => {
    if (key === "google-connection-v1" && JSON.parse(value).pending) {
      beforeRecordSave = undefined
      entered.resolve()
      await release.promise
    }
  }
  const beginning = a.auth.beginGoogleDocsAuth({ ensureServer: async () => "127.0.0.1:7842" })
  const rejected = expect(beginning).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  const disconnecting = b.auth.disconnectGoogleDocs()
  release.resolve()
  await Promise.all([rejected, disconnecting])
  expect(await a.pending.getGoogleOAuthPending()).toBeNull()
})

it("getAccessToken cannot cross accounts when its refresh starts during a pending authorization", async () => {
  const a = realm(),
    b = realm()
  const pending = await prepare(b)
  const entered = deferred<void>(),
    delayed = deferred<GoogleHttpResponse>()
  const reading = a.auth.getGoogleAccessToken({
    http: async () => {
      entered.resolve()
      return delayed.promise
    },
  })
  const rejected = expect(reading).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  await b.auth.completeGoogleDocsAuth({ state: pending.state, code: "new" }, { http: exchange })
  delayed.resolve(response('{"access_token":"late"}'))
  await rejected
  expect((await b.config.loadGoogleTokens())?.accessToken).toBe("new")
})

it("pins refresh to the account in the first snapshot even if delivery is delayed", async () => {
  const entered = deferred<void>(),
    release = deferred<void>()
  let held = false
  const a = realm(async (input) => {
      const reply = await host.call(input)
      if (input.action === "snapshot" && !held) {
        held = true
        entered.resolve()
        await release.promise
      }
      return reply
    }),
    b = realm()
  const http = jest.fn<ReturnType<GoogleHttpFn>, Parameters<GoogleHttpFn>>(async () =>
    response('{"access_token":"fresh"}')
  )
  const reading = a.auth.getGoogleAccessToken({ http })
  const rejected = expect(reading).rejects.toMatchObject({ code: "notAuthorized" })
  await entered.promise
  const pending = await prepare(b)
  await b.auth.completeGoogleDocsAuth({ state: pending.state, code: "new" }, { http: exchange })
  release.resolve()
  await rejected
  expect(http.mock.calls[0][0].body).toContain("refresh_token=rt")
  expect((await b.config.loadGoogleTokens())?.accessToken).toBe("new")
})
it("does not join an in-flight refresh belonging to another account generation", async () => {
  const entered = deferred<void>(),
    release = deferred<void>()
  let held = false
  const a = realm(async (input) => {
      const reply = await host.call(input)
      if (
        input.action === "snapshot" &&
        reply.state.tokens?.accessToken === "old-refreshed" &&
        !held
      ) {
        held = true
        entered.resolve()
        await release.promise
      }
      return reply
    }),
    b = realm()
  const oldRefresh = a.auth.refreshGoogleTokens({
    http: async () => response('{"access_token":"old-refreshed","expires_in":0}'),
  })
  await entered.promise
  const pending = await prepare(b)
  await b.auth.completeGoogleDocsAuth(
    { state: pending.state, code: "new" },
    {
      http: async (request) =>
        response(
          request.url.includes("/token")
            ? '{"access_token":"new","refresh_token":"new-rt","expires_in":0}'
            : "{}"
        ),
    }
  )
  const http = jest.fn(async () => response('{"access_token":"new-refreshed"}'))
  const reading = a.auth.getGoogleAccessToken({ http })
  await new Promise<void>((resolve) => setImmediate(resolve))
  release.resolve()
  await oldRefresh
  await expect(reading).resolves.toBe("new-refreshed")
  expect(http).toHaveBeenCalledTimes(1)
  expect((await a.config.loadGoogleTokens())?.accessToken).toBe("new-refreshed")
})
