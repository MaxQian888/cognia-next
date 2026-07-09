/**
 * Feishu/Lark doc → `RawSource` fetcher for the twin ingest pipeline.
 *
 * Pulls a Lark docx / wiki-node / legacy-doc body using the credentials of a
 * bound Platform-Connectors Lark adapter (the user's "bound Feishu account").
 * Two channels:
 *
 *   - `"api"` (default) — native calls to open.feishu.cn via the Rust
 *     `connectors_http_request` bridge (CORS-free, Tauri only). Prefers the
 *     adapter's OAuth `user_access_token` so document ACLs apply as the
 *     connected user; falls back to the tenant token when no user is
 *     connected or the user token is unrecoverably invalid.
 *   - `"cli"` — shells to the user's installed lark-cli through the existing
 *     built-in-skill exec path (`lib/skills/built-in/lark/exec-lark-cli`).
 *     Higher structural fidelity (markdown), but only available where Node's
 *     child_process exists (headless/CLI contexts); in the desktop webview it
 *     degrades to `larkCliUnavailable`.
 *
 * The fetcher is pure retrieval — content it returns enters the standard
 * ingest pipeline where the PII redaction stage runs BEFORE any embed/LLM
 * call. No model calls happen here.
 */

import { isTauri } from "@/lib/tauri"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsHttpRequest, connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken, getUserAccessToken } from "@/lib/connectors/adapters/lark/auth"
import {
  LarkApiError,
  isLarkUserTokenInvalidation,
  withTatRefresh,
  withUserTokenRefresh,
} from "@/lib/connectors/adapters/lark/auth-retry"
import { parseLarkDocUrl, type LarkDocRef } from "./lark-url"

const LARK_API_BASE = "https://open.feishu.cn"

export type LarkFetchChannel = "api" | "cli"

export type LarkIngestErrorCode =
  | "larkInvalidUrl"
  | "larkNoAccount"
  | "larkNotAuthorized"
  | "larkNoPermission"
  | "larkNotFound"
  | "larkUnsupportedType"
  | "larkRateLimited"
  | "larkEmptyDoc"
  | "larkBrowserUnsupported"
  | "larkCliUnavailable"
  | "larkNetwork"

/**
 * Structured fetch failure. `code` + `params` slot directly into the
 * uploader's `tErr(code, params)` localization against
 * `twin.sourceUploader.errors.*`.
 */
export class LarkIngestError extends Error {
  readonly code: LarkIngestErrorCode
  readonly params?: Record<string, string>

  constructor(code: LarkIngestErrorCode, params?: Record<string, string>) {
    super(params?.reason ? `${code}: ${params.reason}` : code)
    this.name = "LarkIngestError"
    this.code = code
    this.params = params
  }
}

/**
 * Lark business codes that mean "the caller has no access to this doc".
 * Sourced from the docx/wiki/drive permission error families; the HTTP 403
 * prong in `mapLarkError` is the safety net for codes not listed here.
 */
export const LARK_FORBIDDEN_CODES: ReadonlySet<number> = new Set([
  99991672, // app scope not granted
  1254302, // docx: forbidden
  1254036, // docx: no doc permission
  131006, // wiki: no node permission
])

/** Lark business codes that mean "this doc/node does not exist". */
export const LARK_NOT_FOUND_CODES: ReadonlySet<number> = new Set([
  1254005, // docx: document not exist
  1254040, // docx: not found (variant)
  131005, // wiki: node not exist
  230005, // legacy doc not exist
])

/** Lark business codes that mean "rate limited". */
export const LARK_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([
  99991400, // app rate limit
  1254290, // docx: too many requests
])

/**
 * Superset of the generic `FetchedUrl` shape from `url-fetcher.ts`, so the
 * result is a drop-in for the pre-add preview and `createTwinSource` staging.
 */
export interface LarkFetchedDoc {
  url: string
  title: string
  contentType: string
  text: string
  docToken: string
  objType: "docx" | "doc"
  wikiToken?: string
  adapterId: string
  channel: LarkFetchChannel
}

type HttpImpl = typeof connectorsHttpRequest

interface ExecLarkCliLike {
  (input: {
    args: readonly string[]
    adapterId?: string
    timeoutMs?: number
  }): Promise<
    | { status: "ok"; data: unknown; adapterId: string }
    | { status: "error"; reason: string; message: string }
  >
}

export interface FetchLarkDocOptions {
  /** Bound Lark adapter instance id (`cai_...`) whose credentials to use. */
  adapterId: string
  /** Fetch channel; defaults to the native OpenAPI channel. */
  channel?: LarkFetchChannel
  /** Test seam — overrides the `connectorsHttpRequest` transport. */
  httpImpl?: HttpImpl
  /** Test seam — overrides the lark-cli exec for the "cli" channel. */
  execImpl?: ExecLarkCliLike
}

interface LarkEnvelope<T> {
  code: number
  msg?: string
  data?: T
}

/**
 * Fetch a Lark doc (docx / wiki node / legacy doc) as raw text ready for
 * twin-source staging. Throws `LarkIngestError` on every failure path.
 */
export async function fetchLarkDocAsRawSource(
  urlOrToken: string,
  opts: FetchLarkDocOptions
): Promise<LarkFetchedDoc> {
  const ref = parseLarkDocUrl(urlOrToken)
  if (!ref) throw new LarkIngestError("larkInvalidUrl")

  if ((opts.channel ?? "api") === "cli") {
    return fetchViaCli(urlOrToken, ref, opts)
  }
  return fetchViaApi(urlOrToken, ref, opts)
}

// ---------------------------------------------------------------------------
// API channel
// ---------------------------------------------------------------------------

async function fetchViaApi(
  input: string,
  ref: LarkDocRef,
  opts: FetchLarkDocOptions
): Promise<LarkFetchedDoc> {
  const http = opts.httpImpl
  if (!http && !isTauri()) {
    // open.feishu.cn sends no CORS headers — a browser fetch can never work.
    throw new LarkIngestError("larkBrowserUnsupported")
  }
  const httpImpl = http ?? connectorsHttpRequest

  const row = await getAdapterInstance(opts.adapterId)
  if (!row || row.type !== "lark" || !row.enabled) {
    throw new LarkIngestError("larkNoAccount")
  }
  const [appId, appSecret] = await Promise.all([
    connectorsKeyringGet(opts.adapterId, "appId"),
    connectorsKeyringGet(opts.adapterId, "appSecret"),
  ])
  if (!appId || !appSecret) {
    throw new LarkIngestError("larkNotAuthorized", { account: row.displayName })
  }

  const apiGet = async <T>(path: string, authHeader: string): Promise<T> => {
    const resp = await httpImpl({
      url: `${LARK_API_BASE}${path}`,
      method: "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json; charset=utf-8",
      },
    })
    let parsed: LarkEnvelope<T> | null = null
    try {
      parsed = resp.body ? (JSON.parse(resp.body) as LarkEnvelope<T>) : null
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
    return parsed.data as T
  }

  /**
   * Run `fn` with the best available identity: OAuth user token (document
   * ACLs apply as the connected user) with silent refresh; tenant token
   * fallback only when the user token is unrecoverably invalid or absent.
   */
  const runWithAuth = async <T>(fn: (authHeader: string) => Promise<T>): Promise<T> => {
    const ctx = { adapterId: opts.adapterId, appId, appSecret }
    const userToken = await getUserAccessToken(opts.adapterId)
    if (userToken) {
      try {
        return await withUserTokenRefresh(ctx, async () => {
          const token = (await getUserAccessToken(opts.adapterId)) ?? userToken
          return fn(`Bearer ${token}`)
        })
      } catch (err) {
        // Fall back to the bot identity only when the user identity is
        // unrecoverable: the token stayed invalid after the retry, or the
        // refresh itself failed (e.g. no refresh token in the keyring).
        const refreshFailed = err instanceof Error && err.message.includes("user token refresh")
        if (!isLarkUserTokenInvalidation(err) && !refreshFailed) {
          throw mapLarkError(err, row.displayName)
        }
      }
    }
    try {
      return await withTatRefresh(ctx, async () => {
        const tat = await getTenantAccessToken({ appId, appSecret })
        return fn(`Bearer ${tat}`)
      })
    } catch (err) {
      throw mapLarkError(err, row.displayName)
    }
  }

  return runWithAuth(async (authHeader) => {
    let docToken = ref.token
    let objType: "docx" | "doc" = ref.kind === "doc" ? "doc" : "docx"
    let wikiToken: string | undefined
    let title = ""

    if (ref.kind === "wiki") {
      wikiToken = ref.token
      const node = await apiGet<{
        node?: { obj_token?: string; obj_type?: string; title?: string }
      }>(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(ref.token)}`, authHeader)
      const objTokenRaw = node.node?.obj_token
      const objTypeRaw = node.node?.obj_type
      if (!objTokenRaw || (objTypeRaw !== "docx" && objTypeRaw !== "doc")) {
        throw new LarkIngestError("larkUnsupportedType", { type: objTypeRaw ?? "unknown" })
      }
      docToken = objTokenRaw
      objType = objTypeRaw
      title = node.node?.title ?? ""
    }

    let text: string
    if (objType === "docx") {
      const [content, meta] = await Promise.all([
        apiGet<{ content?: string }>(
          `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/raw_content`,
          authHeader
        ),
        title
          ? Promise.resolve(null)
          : apiGet<{ document?: { title?: string } }>(
              `/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}`,
              authHeader
            ),
      ])
      text = content.content ?? ""
      if (!title) title = meta?.document?.title ?? ""
    } else {
      // Legacy doc (docs/<token>) — old v2 API still serves raw content.
      const content = await apiGet<{ content?: string }>(
        `/open-apis/doc/v2/${encodeURIComponent(docToken)}/raw_content`,
        authHeader
      )
      text = content.content ?? ""
    }

    if (!text.trim()) {
      throw new LarkIngestError("larkEmptyDoc", { title: title || docToken })
    }
    return {
      url: input,
      title: title || docToken,
      contentType: "text/plain",
      text,
      docToken,
      objType,
      wikiToken,
      adapterId: opts.adapterId,
      channel: "api" as const,
    }
  })
}

/** Map a raw API/transport failure into a localized `LarkIngestError`. */
export function mapLarkError(err: unknown, account?: string): LarkIngestError {
  if (err instanceof LarkIngestError) return err
  if (err instanceof LarkApiError) {
    const code = err.code
    if (code !== null && LARK_FORBIDDEN_CODES.has(code)) {
      return new LarkIngestError("larkNoPermission", account ? { account } : undefined)
    }
    if (code !== null && LARK_NOT_FOUND_CODES.has(code)) {
      return new LarkIngestError("larkNotFound")
    }
    if (code !== null && LARK_RATE_LIMIT_CODES.has(code)) {
      return new LarkIngestError("larkRateLimited")
    }
    if (err.status === 403) {
      return new LarkIngestError("larkNoPermission", account ? { account } : undefined)
    }
    if (err.status === 404) return new LarkIngestError("larkNotFound")
    if (err.status === 429) return new LarkIngestError("larkRateLimited")
    if (err.status === 401)
      return new LarkIngestError("larkNotAuthorized", { account: account ?? "" })
    return new LarkIngestError("larkNetwork", { reason: err.message })
  }
  const reason = err instanceof Error ? err.message : String(err)
  return new LarkIngestError("larkNetwork", { reason })
}

// ---------------------------------------------------------------------------
// CLI channel
// ---------------------------------------------------------------------------

async function fetchViaCli(
  input: string,
  ref: LarkDocRef,
  opts: FetchLarkDocOptions
): Promise<LarkFetchedDoc> {
  let exec = opts.execImpl
  if (!exec) {
    try {
      const mod = await import("@/lib/skills/built-in/lark/exec-lark-cli")
      exec = mod.execLarkCli as ExecLarkCliLike
    } catch {
      throw new LarkIngestError("larkCliUnavailable")
    }
  }

  // lark-cli's `docs +fetch` resolves wiki tokens to the underlying doc
  // itself, so every ref kind goes through the same subcommand.
  let result: Awaited<ReturnType<ExecLarkCliLike>>
  try {
    result = await exec({
      args: ["docs", "+fetch", "--api-version", "v2", "--doc-token", ref.token],
      adapterId: opts.adapterId,
    })
  } catch (err) {
    // child_process is stubbed in the webview bundle — exec throws there.
    throw new LarkIngestError("larkCliUnavailable", {
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.status !== "ok") {
    if (result.reason === "binary_not_found" || result.reason === "auth_unavailable") {
      throw new LarkIngestError("larkCliUnavailable", { reason: result.message })
    }
    throw new LarkIngestError("larkNetwork", { reason: result.message })
  }

  const { text, title } = normalizeCliPayload(result.data)
  if (!text.trim()) {
    throw new LarkIngestError("larkEmptyDoc", { title: title || ref.token })
  }
  return {
    url: input,
    title: title || ref.token,
    contentType: "text/markdown",
    text,
    docToken: ref.token,
    objType: ref.kind === "doc" ? "doc" : "docx",
    wikiToken: ref.kind === "wiki" ? ref.token : undefined,
    adapterId: opts.adapterId,
    channel: "cli",
  }
}

/**
 * Normalize lark-cli's `docs +fetch` payload — either raw markdown text or a
 * JSON object whose exact field names vary by CLI version — into text+title.
 */
export function normalizeCliPayload(data: unknown): { text: string; title: string } {
  if (typeof data === "string") return { text: data, title: "" }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    const nested = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<
      string,
      unknown
    >
    const text = firstString(nested.markdown, nested.content, nested.text, nested.raw_content) ?? ""
    const title =
      firstString(nested.title, (nested.document as Record<string, unknown> | undefined)?.title) ??
      ""
    if (text) return { text, title }
    return { text: JSON.stringify(data, null, 2), title }
  }
  return { text: "", title: "" }
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v
  }
  return undefined
}
