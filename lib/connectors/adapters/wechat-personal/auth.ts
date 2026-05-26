/**
 * iLink QR-login flow, used by the settings wizard before an adapter row
 * exists. `requestLoginQr` fetches the QR image; `pollLoginStatus` is polled
 * until the user confirms on their phone, at which point the gateway returns
 * the `bot_token` + `baseurl` we persist (token → keyring, baseurl → settings).
 *
 * HTTP is injected so the wizard wires the Tauri proxy
 * (`connectorsHttpRequest`) while tests pass a mock.
 */

import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import {
  ILINK_DEFAULT_BASE_URL,
  ILINK_BOT_TYPE,
  ILINK_PATHS,
  buildIlinkHeaders,
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

/** Request a fresh login QR code. Returns the qrcode id + base64 image. */
export async function requestLoginQr(
  http: IlinkHttp = defaultHttp,
  baseUrl: string = ILINK_DEFAULT_BASE_URL
): Promise<IlinkQrcodeResponse> {
  const resp = await http({
    url: `${baseUrl}${ILINK_PATHS.getBotQrcode}?bot_type=${ILINK_BOT_TYPE}`,
    method: "GET",
    headers: buildIlinkHeaders(),
    timeoutMs: 15_000,
  })
  return JSON.parse(resp.body) as IlinkQrcodeResponse
}

/**
 * Poll the scan status for a qrcode. The wizard calls this on an interval;
 * `status` transitions `wait` → `scaned` → `confirmed` (or `expired`). On
 * `confirmed` the response carries `bot_token` + `baseurl`.
 */
export async function pollLoginStatus(
  qrcode: string,
  http: IlinkHttp = defaultHttp,
  baseUrl: string = ILINK_DEFAULT_BASE_URL
): Promise<IlinkQrStatusResponse> {
  const resp = await http({
    url: `${baseUrl}${ILINK_PATHS.getQrcodeStatus}?qrcode=${encodeURIComponent(qrcode)}`,
    method: "GET",
    headers: buildIlinkHeaders(),
    timeoutMs: 15_000,
  })
  return JSON.parse(resp.body) as IlinkQrStatusResponse
}
