import { createGoogleDocsTestHost } from "./google-docs-host"

it("shares one claim and version fence across its frontend clients", async () => {
  const data = new Map<string, string>()
  const host = createGoogleDocsTestHost({
    load: async (key) => data.get(key) ?? null,
    save: async (key, value) => {
      data.set(key, value)
    },
    delete: async (key) => {
      data.delete(key)
    },
  })
  const attempt = await host.call({ action: "begin" })
  await host.call({
    action: "setPending",
    authorization: attempt.state.authorization,
    pending: {
      state: "google:test",
      codeVerifier: "v",
      redirectUri: "http://127.0.0.1/callback",
      ts: 0,
    },
  })
  await host.call({ action: "claim", state: "google:test", now: 1 })
  await expect(host.call({ action: "claim", state: "google:test", now: 1 })).rejects.toThrow(
    "mismatch"
  )
  await host.call({ action: "disconnect" })
  await expect(
    host.call({
      action: "commit",
      authorization: attempt.state.authorization,
      tokens: { accessToken: "stale", expiresAt: 1 },
    })
  ).rejects.toThrow("stale")
})

it("matches native fail-closed validation for unsupported records and blank tokens", async () => {
  const data = new Map<string, string>()
  const host = createGoogleDocsTestHost({
    load: async (key) => data.get(key) ?? null,
    save: async (key, value) => {
      data.set(key, value)
    },
    delete: async (key) => {
      data.delete(key)
    },
  })
  data.set("google-connection-v1", JSON.stringify({ version: 99 }))
  await expect(host.call({ action: "snapshot" })).rejects.toThrow("unsupported")
  data.clear()
  const state = (await host.call({ action: "begin" })).state
  await host.call({
    action: "setPending",
    authorization: state.authorization,
    pending: { state: "s", codeVerifier: "v", redirectUri: "http://localhost/callback", ts: 0 },
  })
  await host.call({ action: "claim", state: "s", now: 0 })
  await expect(
    host.call({
      action: "commit",
      authorization: state.authorization,
      tokens: { accessToken: "  ", expiresAt: 1 },
    })
  ).rejects.toThrow("invalid Google access token")
  expect((await host.call({ action: "snapshot" })).state.tokens).toBeNull()
  const valid = (
    await host.call({
      action: "commit",
      authorization: state.authorization,
      tokens: { accessToken: "valid", expiresAt: 1 },
    })
  ).state
  await expect(
    host.call({
      action: "refresh",
      connection: valid.connection,
      tokens: { accessToken: " ", expiresAt: 1 },
    })
  ).rejects.toThrow("invalid Google access token")
  expect((await host.call({ action: "snapshot" })).state.tokens?.accessToken).toBe("valid")
})
