/**
 * Authenticated Feishu/Lark OpenAPI harness shared by every non-IM reader.
 *
 * Extracted verbatim from `lib/twin/ingest/lark-doc-fetcher.ts`, which was the
 * only caller until the remote-document providers (ADR-0134) needed the same
 * three things for sheets and Bitable:
 *
 *   1. the Rust `connectors_http_request` bridge (open.feishu.cn sends no CORS
 *      headers, so a browser fetch can never work);
 *   2. the bound adapter's app credentials out of the OS keyring;
 *   3. "run this as the connected USER, fall back to the bot" — with silent
 *      token refresh on both identities.
 *
 * Identity order matters and is not an optimization: document ACLs are
 * evaluated against the caller, so the tenant (bot) token can see strictly
 * less than the user token. The bot is a fallback for when no user is
 * connected, never a shortcut.
 *
 * Error policy: this module throws `LarkAccessError` for the pre-flight
 * failures it can name (wrong host / no adapter / no credentials) and lets
 * `LarkApiError` out unchanged, optionally passed through the caller's
 * `mapError` at exactly the two points the original code mapped. Callers own
 * their own localized error taxonomy; this module owns none.
 */

import { isTauri } from "@/lib/tauri"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken, getUserAccessToken } from "./auth"
import {
  LarkApiError,
  isLarkUserTokenInvalidation,
  withTatRefresh,
  withUserTokenRefresh,
} from "./auth-retry"

export const LARK_API_BASE = "https://open.feishu.cn"

type HttpImpl = typeof connectorsHttpRequest

/** Pre-flight failures that are about the account, not the request. */
export type LarkAccessErrorCode = "browserUnsupported" | "noAccount" | "notAuthorized"

export class LarkAccessError extends Error {
  readonly code: LarkAccessErrorCode
  /** Adapter display name, when one was resolved before the failure. */
  readonly account?: string

  constructor(code: LarkAccessErrorCode, account?: string) {
    super(account ? `${code}: ${account}` : code)
    this.name = "LarkAccessError"
    this.code = code
    this.account = account
  }
}

interface LarkEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

/** JSON calls bound to one resolved identity. Paths are absolute (`/open-apis/...`). */
export interface LarkAuthedApi {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}

export interface LarkAuthedApiAccount {
  adapterId: string
  displayName: string
}

export interface WithLarkAuthedApiOptions {
  /** Bound Lark adapter instance id (`cai_...`) whose credentials to use. */
  adapterId: string
  /** Test seam — overrides the `connectorsHttpRequest` transport. */
  httpImpl?: HttpImpl
  /**
   * Refuse to fall back to the bot identity.
   *
   * A few Lark endpoints accept ONLY a `user_access_token` — cloud-doc search
   * (`/open-apis/suite/docs-api/search/object`) is one. Retrying those as the
   * tenant produces a misleading permission error, so callers that know the
   * constraint set this and get `notAuthorized` up front instead.
   */
  requireUserIdentity?: boolean
  /**
   * Applied to a failure from the authenticated call, at the same two points
   * the original doc fetcher mapped: after an unrecoverable user-identity
   * error, and after the tenant fallback fails. Return value is thrown as-is.
   */
  mapError?: (err: unknown, account: string) => unknown
}

/**
 * Resolve the best available Lark identity for `adapterId` and run `fn` with a
 * JSON API bound to it.
 */
export async function withLarkAuthedApi<T>(
  opts: WithLarkAuthedApiOptions,
  fn: (api: LarkAuthedApi, account: LarkAuthedApiAccount) => Promise<T>
): Promise<T> {
  const http = opts.httpImpl
  if (!http && !isTauri()) {
    // open.feishu.cn sends no CORS headers — a browser fetch can never work.
    throw new LarkAccessError("browserUnsupported")
  }
  const httpImpl = http ?? connectorsHttpRequest

  const row = await getAdapterInstance(opts.adapterId)
  if (!row || row.type !== "lark" || !row.enabled) {
    throw new LarkAccessError("noAccount")
  }
  const [appId, appSecret] = await Promise.all([
    connectorsKeyringGet(opts.adapterId, "appId"),
    connectorsKeyringGet(opts.adapterId, "appSecret"),
  ])
  if (!appId || !appSecret) {
    throw new LarkAccessError("notAuthorized", row.displayName)
  }

  const call = async <R>(
    path: string,
    authHeader: string,
    init?: { method: "POST"; body: unknown }
  ): Promise<R> => {
    const resp = await httpImpl({
      url: `${LARK_API_BASE}${path}`,
      method: init?.method ?? "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json; charset=utf-8",
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    })
    let parsed: LarkEnvelope<R> | null = null
    try {
      parsed = resp.body ? (JSON.parse(resp.body) as LarkEnvelope<R>) : null
    } catch {
      // Non-JSON body — fall through to the status check below.
    }
    if (resp.status >= 400 || !parsed || parsed.code !== 0) {
      throw new LarkApiError({
        status: resp.status,
        code: parsed?.code ?? null,
        message: `Lark ${path} failed: code=${parsed?.code ?? "?"}, msg=${parsed?.msg ?? resp.body?.slice(0, 200) ?? "unknown"}`,
      })
    }
    return parsed.data as R
  }

  const bindApi = (authHeader: string): LarkAuthedApi => ({
    get: <R>(path: string) => call<R>(path, authHeader),
    post: <R>(path: string, body: unknown) => call<R>(path, authHeader, { method: "POST", body }),
  })

  const account: LarkAuthedApiAccount = { adapterId: opts.adapterId, displayName: row.displayName }
  const rethrow = (err: unknown): never => {
    throw opts.mapError ? opts.mapError(err, row.displayName) : err
  }

  const ctx = { adapterId: opts.adapterId, appId, appSecret }
  const userToken = await getUserAccessToken(opts.adapterId)
  if (opts.requireUserIdentity && !userToken) {
    throw new LarkAccessError("notAuthorized", row.displayName)
  }
  if (userToken) {
    try {
      return await withUserTokenRefresh(ctx, async () => {
        const token = (await getUserAccessToken(opts.adapterId)) ?? userToken
        return fn(bindApi(`Bearer ${token}`), account)
      })
    } catch (err) {
      // Fall back to the bot identity only when the user identity is
      // unrecoverable: the token stayed invalid after the retry, or the
      // refresh itself failed (e.g. no refresh token in the keyring).
      const refreshFailed = err instanceof Error && err.message.includes("user token refresh")
      if (!isLarkUserTokenInvalidation(err) && !refreshFailed) {
        rethrow(err)
      }
      if (opts.requireUserIdentity) rethrow(err)
    }
  }
  try {
    return await withTatRefresh(ctx, async () => {
      const tat = await getTenantAccessToken({ appId, appSecret })
      return fn(bindApi(`Bearer ${tat}`), account)
    })
  } catch (err) {
    return rethrow(err)
  }
}
