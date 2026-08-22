/**
 * Telegram webhook registration (`setWebhook` / `deleteWebhook`).
 *
 * Webhook-transport bots used to be registered BY HAND: the config form showed
 * the callback URL with a Copy button and a link to Telegram's API reference,
 * and the docs claimed the app called `setWebhook` itself — which nothing did.
 * Two things were wrong with that. The adapter reported `running` while
 * Telegram had never been told where to push, so a mis-registered bot looked
 * healthy and silently received nothing; and the `allowed_updates` list was
 * whatever the operator had typed months earlier, so every addition to
 * {@link TELEGRAM_ALLOWED_UPDATES} reached long-poll bots only.
 *
 * This module owns the registration side of that contract. The adapter calls
 * it on `start()` (and again whenever the resolved public URL changes, because
 * a Cloudflared quick tunnel gets a new hostname on every restart) and calls
 * {@link deleteTelegramWebhook} on `stop()`.
 *
 * Every function takes its I/O as an injected dependency: the adapter runs in
 * the desktop webview and in the headless brain, and the tests must not reach
 * the Tauri bridge at all.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { isTauri } from "@/lib/platform/detect"
import { resolveLarkApiBase } from "@/lib/connectors/lark-web/entry-client"
import type { TauriHttpRequest, TauriHttpResponse } from "@/types/connectors/adapter"
import {
  connectorWebhookPath,
  resolveConnectorsIngressBase,
} from "@/lib/connectors/server-transport"
import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates"

const TELEGRAM_API_BASE = "https://api.telegram.org"

/** Adapter type segment of the inbound route (`axum_app.rs`). */
const TELEGRAM_ADAPTER_TYPE = "telegram"

export type TelegramHttp = (req: TauriHttpRequest) => Promise<TauriHttpResponse>

/**
 * Why a webhook URL could not be resolved. Each maps to an operator-actionable
 * health reason — "cannot register" must never look like "registered fine".
 */
export type TelegramWebhookUrlProblem = "no_public_base" | "not_https"

export type TelegramWebhookUrlResolution =
  { ok: true; url: string } | { ok: false; problem: TelegramWebhookUrlProblem }

export interface TelegramWebhookUrlInput {
  adapterId: string
  /**
   * `AdapterInstanceRow.publicUrl`, surfaced as `ctx.tauri.publicBaseUrl()`.
   * An explicit operator override — a reverse proxy or named tunnel whose
   * hostname is stable — and it wins over the discovered ingress base.
   */
  publicBaseUrl?: string | null
  /** `isTauri()` — the desktop reaches the public internet via cloudflared. */
  isDesktop: boolean
  /** Cloudflared origin, when a tunnel is running. Desktop only. */
  tunnelUrl?: string | null
  /** Public origin of a headless/companion deployment. */
  publicBase?: string | null
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}

/**
 * Build the URL Telegram should push to.
 *
 * `publicBaseUrl` is accepted in both shapes an operator might have stored:
 * a bare origin (`https://bot.example.com`), which gets the adapter's webhook
 * path appended, or the complete callback URL already ending in that path,
 * which is used as-is. Guessing wrong in either direction registers a URL the
 * local axum router does not serve, so both are handled rather than one being
 * declared "the" format.
 */
export function resolveTelegramWebhookUrl(
  input: TelegramWebhookUrlInput
): TelegramWebhookUrlResolution {
  const path = connectorWebhookPath(TELEGRAM_ADAPTER_TYPE, input.adapterId)
  const override = input.publicBaseUrl?.trim()

  const url = override
    ? trimTrailingSlashes(override).endsWith(path)
      ? trimTrailingSlashes(override)
      : `${trimTrailingSlashes(override)}${path}`
    : (() => {
        const base = resolveConnectorsIngressBase({
          isDesktop: input.isDesktop,
          tunnelUrl: input.tunnelUrl,
          publicBase: input.publicBase,
        })
        return base ? `${base}${path}` : null
      })()

  if (!url) return { ok: false, problem: "no_public_base" }
  // Telegram refuses to register a non-HTTPS webhook outright, and the 400 it
  // answers with is far less legible than saying so here.
  if (!/^https:\/\//i.test(url)) return { ok: false, problem: "not_https" }
  return { ok: true, url }
}

/** Registration failure carrying the HTTP / Bot-API status for the health reason. */
export class TelegramWebhookError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = "TelegramWebhookError"
  }
}

export interface TelegramWebhookApiOptions {
  botToken: string
  /** Default: the real Tauri HTTP bridge. */
  http?: TelegramHttp
  /** Default: "https://api.telegram.org". */
  apiBase?: string
}

async function callBotApi<T = unknown>(
  method: string,
  payload: Record<string, unknown>,
  opts: TelegramWebhookApiOptions
): Promise<T> {
  const http = opts.http ?? connectorsHttpRequest
  const apiBase = opts.apiBase ?? TELEGRAM_API_BASE
  const resp = await http({
    url: `${apiBase}/bot${opts.botToken}/${method}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 15_000,
  })

  let body: { ok?: boolean; description?: string; result?: T }
  try {
    body = JSON.parse(resp.body) as { ok?: boolean; description?: string; result?: T }
  } catch {
    throw new TelegramWebhookError(
      `Telegram ${method} returned a non-JSON body: ${resp.body.slice(0, 200)}`,
      resp.status
    )
  }
  if (!body.ok) {
    throw new TelegramWebhookError(
      `Telegram ${method} failed: ${body.description ?? resp.body.slice(0, 200)}`,
      resp.status
    )
  }
  return body.result as T
}

export interface SetTelegramWebhookOptions extends TelegramWebhookApiOptions {
  url: string
  /**
   * Sent as `secret_token`; Telegram echoes it back in the
   * `X-Telegram-Bot-Api-Secret-Token` header of every delivery.
   *
   * REQUIRED, not optional: `verify_telegram` in `axum_app.rs` answers 401
   * when the adapter has no `secretToken` in the keyring, so a webhook
   * registered without one points Telegram at a receiver that rejects
   * every single delivery. The adapter refuses to register instead.
   */
  secretToken: string
}

/**
 * Point Telegram at `url` for this bot.
 *
 * `allowed_updates` and `secret_token` are sent on EVERY call, never
 * conditionally: `setWebhook` replaces the whole registration, so omitting a
 * field resets it to Telegram's default (all update types minus the opt-in
 * ones for `allowed_updates`; no secret at all for `secret_token`).
 */
export async function setTelegramWebhook(opts: SetTelegramWebhookOptions): Promise<void> {
  await callBotApi(
    "setWebhook",
    {
      url: opts.url,
      secret_token: opts.secretToken,
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
      // Updates that queued while the bot was down are still the user's
      // messages; deliver them rather than dropping them on every restart.
      drop_pending_updates: false,
    },
    opts
  )
}

/**
 * Retract the registration.
 *
 * Called when the webhook transport stops, which covers the case that
 * otherwise breaks a bot permanently: switching a row from webhook to long
 * poll leaves the old registration live, and Telegram answers every
 * `getUpdates` with 409 for as long as a webhook exists. Pending updates are
 * deliberately kept — Telegram holds them for ~24h and hands them over once a
 * transport comes back.
 */
export async function deleteTelegramWebhook(opts: TelegramWebhookApiOptions): Promise<void> {
  await callBotApi("deleteWebhook", { drop_pending_updates: false }, opts)
}

/**
 * The host facts {@link resolveTelegramWebhookUrl} needs, as functions so the
 * adapter can re-read them on every re-check — a Cloudflared quick tunnel is
 * started and stopped from Settings while adapters are running, and its
 * hostname is different every time.
 */
export interface TelegramWebhookEnvironment {
  isDesktop: () => boolean
  tunnelUrl: () => Promise<string | null>
  publicBase: () => string | null
}

/**
 * Production environment. Every lookup is a dynamic import so the adapter's
 * module graph — which is loaded on every host, including the headless brain
 * and the mobile bundle — does not statically pull in the desktop-only tunnel
 * bridge.
 */
export const defaultTelegramWebhookEnvironment: TelegramWebhookEnvironment = {
  isDesktop: isTauri,
  tunnelUrl: async () => {
    try {
      const { getTunnelInfo } = await import("@/lib/connectivity/tunnel-resolver")
      return (await getTunnelInfo())?.publicUrl ?? null
    } catch {
      return null
    }
  },
  // `resolveLarkApiBase()` reads the companion's configured API origin; it is
  // Lark-named for historical reasons but is the shared "where does this
  // deployment live" answer every connector form already uses.
  publicBase: () =>
    resolveLarkApiBase() || (typeof window === "undefined" ? null : window.location.origin),
}

/** {@link resolveTelegramWebhookUrl} against the live host. */
export async function resolveTelegramWebhookUrlFromEnvironment(
  input: { adapterId: string; publicBaseUrl?: string | null },
  env: TelegramWebhookEnvironment = defaultTelegramWebhookEnvironment
): Promise<TelegramWebhookUrlResolution> {
  const isDesktop = env.isDesktop()
  return resolveTelegramWebhookUrl({
    adapterId: input.adapterId,
    publicBaseUrl: input.publicBaseUrl,
    isDesktop,
    // Only the desktop path consults the tunnel; skip the bridge round-trip
    // entirely on a headless host, which has no cloudflared to ask.
    tunnelUrl: isDesktop ? await env.tunnelUrl() : null,
    publicBase: env.publicBase(),
  })
}

/** The half of `getWebhookInfo` that says whether deliveries are landing. */
export interface TelegramWebhookInfo {
  /** URL Telegram currently pushes to; empty string when no webhook is set. */
  url: string
  /** Updates Telegram is holding because delivery is failing. */
  pendingUpdateCount: number
  /** Telegram's own description of the last failed delivery attempt. */
  lastErrorMessage?: string
}

/**
 * Ask Telegram how the registration is actually doing.
 *
 * `setWebhook` succeeding proves only that the URL is well-formed — Telegram
 * does not check that anything answers there. A tunnel pointed at the wrong
 * local port, a stopped app, or a secret mismatch all register fine and then
 * fail on every delivery, which from the app's side is indistinguishable from
 * "nobody has messaged the bot". `last_error_message` is where Telegram says
 * so, and it is the only place that difference is visible.
 */
export async function getTelegramWebhookInfo(
  opts: TelegramWebhookApiOptions
): Promise<TelegramWebhookInfo> {
  const result = await callBotApi<{
    url?: string
    pending_update_count?: number
    last_error_message?: string
  }>("getWebhookInfo", {}, opts)
  return {
    url: result?.url ?? "",
    pendingUpdateCount: result?.pending_update_count ?? 0,
    lastErrorMessage: result?.last_error_message,
  }
}
