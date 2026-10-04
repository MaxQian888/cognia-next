/**
 * Feishu / Lark login through `genericOAuth` (ADR-0215 §2).
 *
 * Feishu is not OIDC: no discovery and no ID token. The authorize endpoint is
 * v1, the token endpoint is **v2** (JSON body, errors in `code`), and the
 * profile comes from `/authen/v1/user_info` wrapped in `data`.
 *
 * # Keyed on (tenant_key, union_id)
 *
 * `open_id` is per app: the same person has a different one in every bot app.
 * `union_id` is stable across one developer's apps, so the account subject is
 * `<tenant_key>:<union_id>`, the same pair the IM principal registry and the
 * identity plane file as `lark:<tenant_key>:<union_id>`.
 *
 * # Never an email identity
 *
 * Feishu often returns no email, and when it does nothing says the person
 * verified it. Accounts merge only on an email two providers both verified
 * (`accountLinking` in auth.ts), so a real but unverified Feishu address
 * would block another provider's sign-up with that address. Every Feishu
 * account therefore carries a per-person placeholder on the reserved
 * `.invalid` TLD (RFC 2606), never marked verified: it can neither collide
 * with nor merge into another account. Clients ignore `.invalid` addresses.
 */

import type { FeishuCredentials } from "../config"

export const FEISHU_PROVIDER_ID = "feishu"

export const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
export const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token"
export const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info"

/** The reserved domain the placeholder addresses live under. */
export const FEISHU_PLACEHOLDER_EMAIL_DOMAIN = "feishu.users.invalid"

interface FeishuEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

interface FeishuTokenResponse {
  code: number
  error?: string
  error_description?: string
  access_token?: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
  scope?: string
  token_type?: string
}

interface FeishuUserInfo {
  name?: string
  en_name?: string
  avatar_url?: string
  open_id?: string
  union_id?: string
  tenant_key?: string
}

export class FeishuLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeishuLoginError"
  }
}

/** `<tenant_key>:<union_id>`, the account subject. */
export function feishuAccountSubject(tenantKey: string, unionId: string): string {
  return `${tenantKey}:${unionId}`
}

export function feishuPlaceholderEmail(tenantKey: string, unionId: string): string {
  // Both ids are opaque ASCII tokens; lower-casing keeps the address in the
  // form Better Auth stores emails in.
  return `${unionId}.${tenantKey}@${FEISHU_PLACEHOLDER_EMAIL_DOMAIN}`.toLowerCase()
}

export function feishuProviderConfig(credentials: FeishuCredentials, fetchImpl?: typeof fetch) {
  // Resolved per call, so a stubbed global fetch (tests) is honoured.
  const send: typeof fetch = (input, init) => (fetchImpl ?? fetch)(input, init)
  return {
    providerId: FEISHU_PROVIDER_ID,
    name: "Feishu",
    authorizationUrl: FEISHU_AUTHORIZE_URL,
    tokenUrl: FEISHU_TOKEN_URL,
    userInfoUrl: FEISHU_USER_INFO_URL,
    clientId: credentials.appId,
    clientSecret: credentials.appSecret,
    pkce: true,
    // Basic identity needs no scope; login asks for nothing more (ADR-0215 D9).
    scopes: [] as string[],
    getToken: async (data: { code: string; redirectURI: string; codeVerifier?: string }) => {
      const response = await send(FEISHU_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: credentials.appId,
          client_secret: credentials.appSecret,
          code: data.code,
          redirect_uri: data.redirectURI,
          ...(data.codeVerifier ? { code_verifier: data.codeVerifier } : {}),
        }),
      })
      const body = (await response.json().catch(() => ({ code: -1 }))) as FeishuTokenResponse
      if (body.code !== 0 || !body.access_token) {
        throw new FeishuLoginError(
          `Feishu token exchange failed (${body.code}${body.error ? ` ${body.error}` : ""})`
        )
      }
      return {
        tokenType: body.token_type ?? "Bearer",
        accessToken: body.access_token,
        scopes: body.scope ? body.scope.split(" ").filter(Boolean) : [],
      }
    },
    getUserInfo: async (tokens: { accessToken?: string }) => {
      if (!tokens.accessToken) return null
      const response = await send(FEISHU_USER_INFO_URL, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      const body = (await response
        .json()
        .catch(() => ({ code: -1 }))) as FeishuEnvelope<FeishuUserInfo>
      const info = body.data
      if (body.code !== 0 || !info?.union_id || !info.tenant_key) return null
      return {
        id: feishuAccountSubject(info.tenant_key, info.union_id),
        name: info.name || info.en_name || "Feishu",
        email: feishuPlaceholderEmail(info.tenant_key, info.union_id),
        emailVerified: false,
        image: info.avatar_url,
        tenant_key: info.tenant_key,
        union_id: info.union_id,
      }
    },
    accountSubject: ({ profile }: { profile: Record<string, unknown> }) =>
      feishuAccountSubject(String(profile.tenant_key), String(profile.union_id)),
  }
}
