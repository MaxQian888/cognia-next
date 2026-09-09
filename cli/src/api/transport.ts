/**
 * The two wires a Cognia Host answers on, behind one `execute(name, args)`.
 *
 * `internal` is `POST /internal/_rpc/{name}` with a loopback service token.
 * The host treats a loopback service principal as the policy authority for
 * the Brain plane, so this wire carries every command and neither capability
 * grants nor approval leases apply. It is the headless server's own wire.
 *
 * `device` is `POST /api/_rpc/{name}` with a DPoP-bound device session. Only
 * `execution` and `host-admin` commands are admitted, every capability grant
 * is checked, and `interactive` / `signed-policy` commands need a lease or a
 * policy. It is the wire a paired device uses, local or remote.
 *
 * Nothing here decides *which* wire to use. That is the resolver's job
 * (`cli/src/host/resolve.ts`), so this module stays a pure protocol layer.
 */

import { createCompanionSession, signerFromJwk } from "@cognia/companion-client"

import type { FailureCause } from "../cli/errors"

export const INTERNAL_RPC_PREFIX = "/internal/_rpc"
export const DEVICE_RPC_PREFIX = "/api/_rpc"
export const INTERNAL_OPERATION_PREFIX = "/internal/operations"
export const DEVICE_OPERATION_PREFIX = "/api/operations"

export type HostWire = "internal" | "http"

export interface CommandSuccess {
  ok: true
  result: unknown
  /** The host answered 202: the work is running and `operationId` tracks it. */
  accepted?: boolean
  operationId?: string
}

export interface CommandFailure {
  ok: false
  cause: FailureCause
  message: string
  details?: string[]
  status?: number
  /** The host's own error code, e.g. `unknown_command`. */
  code?: string
  requestId?: string
}

export type CommandOutcome = CommandSuccess | CommandFailure

export interface RequestOptions {
  timeoutMs?: number
  /** Idempotency key for commands the manifest marks `required`. */
  idempotencyKey?: string
  signal?: AbortSignal
}

export interface HostTransport {
  wire: HostWire
  /** One human line naming the plane, for the report header and Inspect block. */
  label: string
  execute(
    name: string,
    args?: Record<string, unknown>,
    options?: RequestOptions
  ): Promise<CommandOutcome>
  /** Raw escape hatch for the routes that are not RPC commands. */
  request(
    method: string,
    routePath: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<CommandOutcome>
}

/** Injected so tests never open a socket, and so TLS pinning can wrap it. */
export type TransportFetch = (url: string, init: RequestInit) => Promise<Response>

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "")
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    // A gateway error page in place of the real response. Keep the body so the
    // Details block can show what actually came back.
    return { __nonJsonBody: text.slice(0, 500) }
  }
}

function stringField(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** Map an HTTP answer onto a cause the failure block can classify. */
export function classifyStatus(status: number, code?: string): FailureCause {
  if (status === 404 || code === "unknown_command") return "unknown-command"
  if (status === 401 || status === 403) {
    return code === "interactive_approval_required" ||
      code === "signed_policy_required" ||
      code === "command_transport_forbidden"
      ? "refused"
      : "auth"
  }
  if (status === 408 || status === 504) return "timeout"
  if (status === 400 || status === 422) return "invalid-request"
  if (status === 428) return "refused"
  if (status >= 500) return "failed"
  return "refused"
}

function failureFromResponse(status: number, body: Record<string, unknown>): CommandFailure {
  const code = stringField(body, "code", "error")
  // The Host answers one problem document (ADR-0175), whose `detail` is the
  // message. `message` and `error_description` are what older Hosts and the
  // OAuth-shaped routes wrote.
  const message =
    stringField(body, "detail", "message", "error_description") ??
    `the host answered HTTP ${status}`
  const nonJson = body.__nonJsonBody
  return {
    ok: false,
    cause: classifyStatus(status, code),
    message,
    status,
    ...(code ? { code } : {}),
    ...(stringField(body, "requestId", "request_id")
      ? { requestId: stringField(body, "requestId", "request_id") }
      : {}),
    ...(typeof nonJson === "string" ? { details: [`non-JSON body: ${nonJson}`] } : {}),
  }
}

function networkFailure(error: unknown): CommandFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === "AbortError") {
    return { ok: false, cause: "timeout", message: "the request exceeded its timeout budget" }
  }
  return { ok: false, cause: "network", message }
}

function successFromResponse(status: number, body: Record<string, unknown>): CommandSuccess {
  if (status === 202) {
    const operationId = stringField(body, "operationId", "operation_id")
    return { ok: true, accepted: true, result: body, ...(operationId ? { operationId } : {}) }
  }
  return { ok: true, result: body }
}

interface HttpCallInput {
  fetchImpl: TransportFetch
  endpoint: string
  method: string
  routePath: string
  body?: unknown
  headers: Record<string, string>
  options?: RequestOptions
}

async function httpCall(input: HttpCallInput): Promise<CommandOutcome> {
  const controller = new AbortController()
  const timeoutMs = input.options?.timeoutMs
  const timer =
    timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  const forwarded = input.options?.signal
  const onAbort = () => controller.abort()
  forwarded?.addEventListener("abort", onAbort)
  try {
    const response = await input.fetchImpl(`${input.endpoint}${input.routePath}`, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: controller.signal,
    })
    const body = await readBody(response)
    return response.ok
      ? successFromResponse(response.status, body)
      : failureFromResponse(response.status, body)
  } catch (error) {
    return networkFailure(error)
  } finally {
    if (timer) clearTimeout(timer)
    forwarded?.removeEventListener("abort", onAbort)
  }
}

export interface InternalTransportOptions {
  endpoint: string
  serviceToken: string
  fetchImpl?: TransportFetch
}

/** Headless wire. The service token is only ever sent to the host that issued it. */
export function internalTransport(options: InternalTransportOptions): HostTransport {
  const endpoint = options.endpoint.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const headers = (extra: Record<string, string> = {}) => ({
    "content-type": "application/json",
    authorization: `Bearer ${options.serviceToken}`,
    ...extra,
  })
  return {
    wire: "internal",
    label: `cognia-server (${endpoint})`,
    execute(name, args = {}, requestOptions) {
      return httpCall({
        fetchImpl,
        endpoint,
        method: "POST",
        routePath: `${INTERNAL_RPC_PREFIX}/${encodeURIComponent(name)}`,
        body: args,
        headers: headers(
          requestOptions?.idempotencyKey ? { "idempotency-key": requestOptions.idempotencyKey } : {}
        ),
        options: requestOptions,
      })
    },
    request(method, routePath, body, requestOptions) {
      return httpCall({
        fetchImpl,
        endpoint,
        method: method.toUpperCase(),
        routePath,
        body,
        headers: headers(),
        options: requestOptions,
      })
    },
  }
}

export interface DeviceTransportOptions {
  endpoint: string
  tenantId: string
  deviceId: string
  privateKeyJwk: JsonWebKey
  /** Pins the host's TLS SubjectPublicKeyInfo when the record carries one. */
  serverFingerprint?: string
  fetchImpl?: TransportFetch
}

/**
 * Device wire. Each request carries a fresh DPoP proof bound to the five-minute
 * access token, so the session is built once and reused across calls rather
 * than re-authenticating per command.
 */
export async function deviceTransport(options: DeviceTransportOptions): Promise<HostTransport> {
  const endpoint = options.endpoint.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const signer = await signerFromJwk(options.deviceId, options.privateKeyJwk)
  const session = createCompanionSession({
    baseUrl: endpoint,
    tenantId: options.tenantId,
    signer,
    fetchImpl: (input, init) => fetchImpl(input, init),
  })

  async function call(
    method: string,
    routePath: string,
    body: unknown,
    requestOptions?: RequestOptions,
    extraHeaders: Record<string, string> = {}
  ): Promise<CommandOutcome> {
    let authorization: Record<string, string>
    try {
      // The proof is bound to the method and path, so it is minted per call
      // and cannot be replayed against a different route.
      authorization = await session.authorizationHeaders(method, routePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, cause: "auth", message }
    }
    const outcome = await httpCall({
      fetchImpl,
      endpoint,
      method,
      routePath,
      body,
      headers: { "content-type": "application/json", ...authorization, ...extraHeaders },
      options: requestOptions,
    })
    // A token that the host no longer accepts is worth exactly one retry with
    // a fresh one. Anything past that is a real authorization problem.
    if (!outcome.ok && outcome.status === 401) {
      session.invalidate()
      const retryAuthorization = await session
        .authorizationHeaders(method, routePath)
        .catch(() => null)
      if (retryAuthorization) {
        return httpCall({
          fetchImpl,
          endpoint,
          method,
          routePath,
          body,
          headers: { "content-type": "application/json", ...retryAuthorization, ...extraHeaders },
          options: requestOptions,
        })
      }
    }
    return outcome
  }

  return {
    wire: "http",
    label: `Cognia Host (${endpoint}, device ${options.deviceId})`,
    execute(name, args = {}, requestOptions) {
      return call(
        "POST",
        `${DEVICE_RPC_PREFIX}/${encodeURIComponent(name)}`,
        args,
        requestOptions,
        requestOptions?.idempotencyKey ? { "idempotency-key": requestOptions.idempotencyKey } : {}
      )
    },
    request(method, routePath, body, requestOptions) {
      return call(method.toUpperCase(), routePath, body, requestOptions)
    },
  }
}

/** Where an accepted command's receipt lives, per wire. */
export function operationPath(wire: HostWire, operationId: string): string {
  const prefix = wire === "internal" ? INTERNAL_OPERATION_PREFIX : DEVICE_OPERATION_PREFIX
  return `${prefix}/${encodeURIComponent(operationId)}`
}
