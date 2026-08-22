/**
 * Webhook registration — URL resolution and the two Bot API calls.
 *
 * The wire payload is asserted field by field because `setWebhook` REPLACES
 * the whole registration: a dropped `allowed_updates` silently reverts the bot
 * to Telegram's defaults, and a dropped `secret_token` clears the secret the
 * local receiver requires. Neither failure produces an error anywhere.
 */

import type { TauriHttpRequest, TauriHttpResponse } from "@/types/connectors/adapter"
import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates"
import {
  TelegramWebhookError,
  deleteTelegramWebhook,
  getTelegramWebhookInfo,
  resolveTelegramWebhookUrl,
  resolveTelegramWebhookUrlFromEnvironment,
  setTelegramWebhook,
  type TelegramWebhookEnvironment,
} from "./webhook-registration"

function okResponse(body: unknown = { ok: true, result: true }): TauriHttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

function makeHttp(response: TauriHttpResponse = okResponse()) {
  const calls: TauriHttpRequest[] = []
  const http = jest.fn(async (req: TauriHttpRequest) => {
    calls.push(req)
    return response
  })
  return { http, calls }
}

describe("resolveTelegramWebhookUrl", () => {
  it("builds the desktop URL from the Cloudflared tunnel origin", () => {
    expect(
      resolveTelegramWebhookUrl({
        adapterId: "tg-1",
        isDesktop: true,
        tunnelUrl: "https://calm-fox.trycloudflare.com",
      })
    ).toEqual({ ok: true, url: "https://calm-fox.trycloudflare.com/webhook/telegram/tg-1" })
  })

  it("nests the headless URL under the /connectors prefix the router is mounted at", () => {
    expect(
      resolveTelegramWebhookUrl({
        adapterId: "tg-1",
        isDesktop: false,
        publicBase: "https://cognia.example.com",
      })
    ).toEqual({ ok: true, url: "https://cognia.example.com/connectors/webhook/telegram/tg-1" })
  })

  it("treats an operator-pinned public URL as an origin and appends the path", () => {
    expect(
      resolveTelegramWebhookUrl({
        adapterId: "tg-1",
        publicBaseUrl: "https://bot.example.com/",
        isDesktop: true,
        tunnelUrl: "https://tunnel.example.com",
      })
    ).toEqual({ ok: true, url: "https://bot.example.com/webhook/telegram/tg-1" })
  })

  it("accepts an operator-pinned URL that is already the full callback URL", () => {
    // Both shapes are plausible in a field nothing validates; appending the
    // path twice would register a URL the axum router does not serve.
    expect(
      resolveTelegramWebhookUrl({
        adapterId: "tg-1",
        publicBaseUrl: "https://bot.example.com/webhook/telegram/tg-1",
        isDesktop: true,
      })
    ).toEqual({ ok: true, url: "https://bot.example.com/webhook/telegram/tg-1" })
  })

  it("reports no_public_base when the tunnel is off and nothing is pinned", () => {
    expect(
      resolveTelegramWebhookUrl({ adapterId: "tg-1", isDesktop: true, tunnelUrl: null })
    ).toEqual({ ok: false, problem: "no_public_base" })
  })

  it("reports not_https rather than letting Telegram reject the call", () => {
    expect(
      resolveTelegramWebhookUrl({
        adapterId: "tg-1",
        isDesktop: false,
        publicBase: "http://localhost:3000",
      })
    ).toEqual({ ok: false, problem: "not_https" })
  })
})

describe("resolveTelegramWebhookUrlFromEnvironment", () => {
  const env = (over: Partial<TelegramWebhookEnvironment> = {}): TelegramWebhookEnvironment => ({
    isDesktop: () => true,
    tunnelUrl: async () => "https://tunnel.example.com",
    publicBase: () => null,
    ...over,
  })

  it("resolves through the live tunnel on the desktop", async () => {
    await expect(
      resolveTelegramWebhookUrlFromEnvironment({ adapterId: "tg-9" }, env())
    ).resolves.toEqual({ ok: true, url: "https://tunnel.example.com/webhook/telegram/tg-9" })
  })

  it("does not consult the tunnel bridge on a headless host", async () => {
    const tunnelUrl = jest.fn(async () => "https://tunnel.example.com")
    const result = await resolveTelegramWebhookUrlFromEnvironment(
      { adapterId: "tg-9" },
      env({ isDesktop: () => false, publicBase: () => "https://cloud.example.com", tunnelUrl })
    )
    expect(tunnelUrl).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      url: "https://cloud.example.com/connectors/webhook/telegram/tg-9",
    })
  })
})

describe("setTelegramWebhook", () => {
  it("sends url, secret_token and the shared allowed_updates list", async () => {
    const { http, calls } = makeHttp()
    await setTelegramWebhook({
      botToken: "TOKEN",
      url: "https://tunnel.example.com/webhook/telegram/tg-1",
      secretToken: "s3cret",
      http,
      apiBase: "https://api.telegram.example",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://api.telegram.example/botTOKEN/setWebhook")
    expect(calls[0].method).toBe("POST")
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
      url: "https://tunnel.example.com/webhook/telegram/tg-1",
      secret_token: "s3cret",
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      drop_pending_updates: false,
    })
  })

  it("requests the same update types the long-poll transport requests", async () => {
    // The whole point of the shared constant: whatever long poll asks for,
    // webhook bots ask for too.
    const { http, calls } = makeHttp()
    await setTelegramWebhook({ botToken: "T", url: "https://x.example/w", secretToken: "s", http })
    const sent = JSON.parse(calls[0].body ?? "{}") as { allowed_updates: string[] }
    expect(sent.allowed_updates).toContain("my_chat_member")
    expect(sent.allowed_updates).toContain("message_reaction")
  })

  it("throws with Telegram's description when the API answers ok:false", async () => {
    const { http } = makeHttp({
      status: 400,
      headers: {},
      body: JSON.stringify({ ok: false, description: "Bad webhook: HTTPS url must be provided" }),
    })
    await expect(
      setTelegramWebhook({ botToken: "T", url: "http://x.example/w", secretToken: "s", http })
    ).rejects.toThrow(/HTTPS url must be provided/)
  })

  it("throws a typed error carrying the status on a non-JSON body", async () => {
    const { http } = makeHttp({ status: 502, headers: {}, body: "<html>bad gateway</html>" })
    await expect(
      setTelegramWebhook({ botToken: "T", url: "https://x.example/w", secretToken: "s", http })
    ).rejects.toMatchObject({ name: "TelegramWebhookError", status: 502 })
    expect(new TelegramWebhookError("x", 1)).toBeInstanceOf(Error)
  })
})

describe("deleteTelegramWebhook", () => {
  it("retracts the registration without dropping queued updates", async () => {
    const { http, calls } = makeHttp()
    await deleteTelegramWebhook({
      botToken: "TOKEN",
      http,
      apiBase: "https://api.telegram.example",
    })

    expect(calls[0].url).toBe("https://api.telegram.example/botTOKEN/deleteWebhook")
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ drop_pending_updates: false })
  })

  it("surfaces an API failure to the caller", async () => {
    const { http } = makeHttp({
      status: 401,
      headers: {},
      body: JSON.stringify({ ok: false, description: "Unauthorized" }),
    })
    await expect(deleteTelegramWebhook({ botToken: "T", http })).rejects.toThrow(/Unauthorized/)
  })
})

describe("getTelegramWebhookInfo", () => {
  it("surfaces Telegram's own delivery error", async () => {
    const { http } = makeHttp(
      okResponse({
        ok: true,
        result: {
          url: "https://tunnel.example.com/webhook/telegram/tg-1",
          pending_update_count: 7,
          last_error_message: "Wrong response from the webhook: 404 Not Found",
        },
      })
    )
    await expect(getTelegramWebhookInfo({ botToken: "T", http })).resolves.toEqual({
      url: "https://tunnel.example.com/webhook/telegram/tg-1",
      pendingUpdateCount: 7,
      lastErrorMessage: "Wrong response from the webhook: 404 Not Found",
    })
  })

  it("reports an empty url when no webhook is registered", async () => {
    const { http } = makeHttp(okResponse({ ok: true, result: { url: "" } }))
    await expect(getTelegramWebhookInfo({ botToken: "T", http })).resolves.toEqual({
      url: "",
      pendingUpdateCount: 0,
      lastErrorMessage: undefined,
    })
  })
})
