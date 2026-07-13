/**
 * Feishu / Lark Open Platform OCR provider (basic_recognize).
 *
 * Endpoint: POST https://open.feishu.cn/open-apis/optical_char_recognition/v1/image/basic_recognize
 *   headers: Authorization: Bearer <tenant_access_token>
 *   body: { image: "<base64>" }
 *   response: { code, msg, data: { text_list: ["..."] } }
 *
 * The tenant_access_token is fetched on first use and cached in memory until
 * 2 minutes before its declared expiry (Lark issues 2h tokens by default).
 */

import { bytesToBase64, normalizeImage } from "../image-prep"
import { OcrError } from "@/lib/ocr/errors"
import {
  type OcrInput,
  type OcrProvider,
  type OcrProviderContext,
  type OcrResult,
} from "@/types/ocr"
import { cloudFetch, parseJson, requireSecret } from "./_http"

const LARK_BASE = "https://open.feishu.cn"
const TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal"
const OCR_PATH = "/open-apis/optical_char_recognition/v1/image/basic_recognize"
const TOKEN_SAFETY_MS = 2 * 60 * 1000

export interface LarkBasicConfig {
  endpoint?: string
  /** Override timestamp source for tests. */
  now?: () => number
  fetchImpl?: typeof fetch
}

interface LarkTokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}
interface LarkOcrResponse {
  code?: number
  msg?: string
  data?: { text_list?: string[] }
}

interface CachedToken {
  token: string
  expiresAt: number
}

const tokenCache = new Map<string, CachedToken>()

/** Test helper — wipes the in-memory token cache between runs. */
export function __clearLarkTokenCache(): void {
  tokenCache.clear()
}

export function buildLarkBasicProvider(inject: { fetchImpl?: typeof fetch } = {}): OcrProvider {
  return {
    id: "lark-basic",
    label: "Feishu / Lark (basic OCR)",
    category: "lark",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: ["appId", "appSecret"],
    async extract(input, ctx) {
      return larkBasicExtract(input, ctx, inject.fetchImpl)
    },
  }
}

export async function larkBasicExtract(
  input: OcrInput,
  ctx: OcrProviderContext,
  fetchImpl?: typeof fetch
): Promise<OcrResult> {
  const appId = requireSecret("lark-basic", ctx.credentials.secrets, "appId")
  const appSecret = requireSecret("lark-basic", ctx.credentials.secrets, "appSecret")
  const config = (ctx.config ?? {}) as LarkBasicConfig
  const base = (config.endpoint ?? LARK_BASE).replace(/\/+$/, "")
  const fetchFn = fetchImpl ?? config.fetchImpl
  const now = config.now ?? Date.now

  const token = await fetchTenantToken(appId, appSecret, base, ctx, fetchFn, now)
  const normalized = await normalizeImage(input.source)
  const start = Date.now()
  const res = await cloudFetch({
    providerId: "lark-basic",
    url: `${base}${OCR_PATH}`,
    headers: { Authorization: `Bearer ${token}` },
    body: { image: bytesToBase64(normalized.bytes) },
    signal: ctx.signal,
    fetchImpl: fetchFn,
  })
  const data = parseJson<LarkOcrResponse>("lark-basic", res.body)
  if (data.code && data.code !== 0) {
    const code = mapLarkCode(data.code)
    if (code === "missing_credentials") {
      // Token may be stale — drop the cache so the next call refetches.
      tokenCache.delete(cacheKey(appId, base))
    }
    throw new OcrError(code, "lark-basic", data.msg ?? `Lark error ${data.code}`)
  }
  const textLines = data.data?.text_list ?? []
  const text = textLines.join("\n")
  return {
    providerId: "lark-basic",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: "",
    combinedText: "",
    languages: input.languages ?? [],
    durationMs: Date.now() - start,
    cached: false,
  }
}

async function fetchTenantToken(
  appId: string,
  appSecret: string,
  base: string,
  ctx: OcrProviderContext,
  fetchFn: typeof fetch | undefined,
  now: () => number
): Promise<string> {
  const key = cacheKey(appId, base)
  const cached = tokenCache.get(key)
  const nowMs = now()
  if (cached && cached.expiresAt - TOKEN_SAFETY_MS > nowMs) {
    return cached.token
  }
  const res = await cloudFetch({
    providerId: "lark-basic",
    url: `${base}${TOKEN_PATH}`,
    body: { app_id: appId, app_secret: appSecret },
    signal: ctx.signal,
    fetchImpl: fetchFn,
  })
  const data = parseJson<LarkTokenResponse>("lark-basic", res.body)
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new OcrError(
      mapLarkCode(data.code ?? -1),
      "lark-basic",
      data.msg ?? "Failed to obtain Lark tenant_access_token."
    )
  }
  const expireSec = Math.max(60, data.expire ?? 7200)
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: nowMs + expireSec * 1000,
  })
  return data.tenant_access_token
}

function cacheKey(appId: string, base: string): string {
  return `${base}|${appId}`
}

function mapLarkCode(code: number): OcrError["code"] {
  if (code === 99991663 || code === 99991664) return "missing_credentials"
  // 99991400 = request trigger frequency limit (official Feishu error code).
  if (code === 99991400) return "rate_limited"
  return "provider_failed"
}

export const larkBasicProvider = buildLarkBasicProvider()
