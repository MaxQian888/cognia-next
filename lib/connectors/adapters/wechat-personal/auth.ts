/**
 * iLink QR-login flow, used by the settings wizard before an adapter row
 * exists. `requestLoginQr` fetches the QR image; `pollLoginStatus` is polled
 * until the user confirms on their phone, at which point the gateway returns
 * the `bot_token` + `baseurl` we persist (token → keyring, baseurl → settings).
 *
 * HTTP is injected so the wizard wires the Tauri proxy
 * (`connectorsHttpRequest`) while tests pass a mock.
 */

import { isPublicHttpUrl } from "../_shared/inbound-media"

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import {
  ILINK_DEFAULT_BASE_URL,
  ILINK_BOT_TYPE,
  ILINK_PATHS,
  buildIlinkHeaders,
  ilinkResultCode,
  type IlinkQrcodeResponse,
  type IlinkQrStatusResponse,
} from "./protocol"

export interface IlinkHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type IlinkHttp = (req: {
  url: string
  method: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}) => Promise<IlinkHttpResponse>

const defaultHttp: IlinkHttp = (req) => connectorsHttpRequest(req)

function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isPublicHttpUrl(value)
  ) {
    throw new Error("iLink login server must be a public HTTPS URL")
  }
  return value.replace(/\/+$/, "")
}

/** Accept only the host-shaped redirect field returned by the login gateway. */
export function resolveIlinkQrRedirect(host: string): string {
  if (!host || /[/:@?#\\\s]/.test(host)) throw new Error("Invalid iLink QR redirect host")
  return normalizeBaseUrl(`https://${host}`)
}

function parseLoginResponse(response: IlinkHttpResponse): Record<string, unknown> {
  if (response.status >= 400) throw new Error(`iLink login HTTP ${response.status}`)
  const body: unknown = JSON.parse(response.body)
  if (ilinkResultCode(body) !== 0) throw new Error("Invalid or unsuccessful iLink login response")
  return body as Record<string, unknown>
}

/** Request a fresh login QR code. Returns the id and QR payload URL. */
export async function requestLoginQr(
  http: IlinkHttp = defaultHttp,
  baseUrl: string = ILINK_DEFAULT_BASE_URL
): Promise<IlinkQrcodeResponse> {
  const resp = await http({
    url: `${normalizeBaseUrl(baseUrl)}${ILINK_PATHS.getBotQrcode}?bot_type=${ILINK_BOT_TYPE}`,
    method: "GET",
    headers: buildIlinkHeaders(),
    timeoutMs: 15_000,
  })
  const body = parseLoginResponse(resp)
  if (
    typeof body.qrcode !== "string" ||
    !body.qrcode ||
    typeof body.qrcode_img_content !== "string" ||
    !body.qrcode_img_content
  )
    throw new Error("iLink login response is missing QR data")
  return body as IlinkQrcodeResponse
}

/**
 * Poll the scan status for a qrcode. The wizard calls this on an interval;
 * `status` transitions `wait` → `scaned` → `confirmed` (or `expired`). On
 * `confirmed` the response carries `bot_token` + `baseurl`.
 */
export async function pollLoginStatus(
  qrcode: string,
  http: IlinkHttp = defaultHttp,
  baseUrl: string = ILINK_DEFAULT_BASE_URL,
  verifyCode?: string
): Promise<IlinkQrStatusResponse> {
  const resp = await http({
    url: `${normalizeBaseUrl(baseUrl)}${ILINK_PATHS.getQrcodeStatus}?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`,
    method: "GET",
    headers: buildIlinkHeaders(),
    timeoutMs: 35_000,
  })
  const body = parseLoginResponse(resp)
  const statuses = [
    "wait",
    "scaned",
    "confirmed",
    "expired",
    "scaned_but_redirect",
    "need_verifycode",
    "verify_code_blocked",
    "binded_redirect",
  ]
  if (typeof body.status !== "string" || !statuses.includes(body.status))
    throw new Error("Unknown iLink login status")
  for (const key of ["bot_token", "ilink_bot_id", "ilink_user_id", "account_id", "redirect_host"]) {
    if (body[key] !== undefined && typeof body[key] !== "string")
      throw new Error(`Invalid iLink login field: ${key}`)
  }
  if (body.baseurl !== undefined) {
    if (typeof body.baseurl !== "string") throw new Error("Invalid iLink login server")
    body.baseurl = normalizeBaseUrl(body.baseurl)
  }
  if (typeof body.ilink_bot_id === "string" && body.ilink_bot_id)
    body.account_id = body.ilink_bot_id
  return body as unknown as IlinkQrStatusResponse
}
