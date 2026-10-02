/**
 * The operator CLI's control flow, with every side effect injected so the
 * whole flow is testable: build the operation, preview a write and require
 * `--yes` or an interactive "y", obtain the Access token, send, and print a
 * safe result or the error envelope (409s show the current revision).
 */

import { DEFAULT_STATUS_API_BASE, validateStatusUrl } from "../../../../lib/status/config"
import { UsageError } from "./args"
import { AuthError, ACCESS_TOKEN_HEADER, resolveAccessToken, type CommandRunner } from "./auth"
import { buildCommand, type Operation } from "./commands"
import { USAGE, renderError, renderRead, renderWriteResult } from "./format"

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>
  fetch: (input: string, init: RequestInit) => Promise<Response>
  run: CommandRunner
  stdout(line: string): void
  stderr(line: string): void
  /** Interactive y/N; resolves false when there is no terminal to ask on. */
  confirm(question: string): Promise<boolean>
  newOperationId(): string
}

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

function apiBase(flag: string | undefined, env: CliDeps["env"]): string {
  const raw = flag ?? env.STATUS_API_BASE ?? DEFAULT_STATUS_API_BASE
  const valid = validateStatusUrl(raw, { allowLoopbackHttp: true })
  if (!valid)
    throw new UsageError(`--api must be an https URL (or http on a loopback host): ${raw}`)
  return valid.replace(/\/+$/, "")
}

function preview(operation: Extract<Operation, { kind: "write" }>, url: string): string[] {
  return [
    "Operation preview",
    `  ${operation.method} ${url}`,
    `  summary:     ${operation.summary}`,
    `  operationId: ${operation.body.operationId}`,
    "  body:",
    ...JSON.stringify(operation.body, null, 2)
      .split("\n")
      .map((line) => `    ${line}`),
  ]
}

async function readBody(response: Response): Promise<{ json: unknown; raw: string }> {
  const raw = await response.text()
  try {
    return { json: JSON.parse(raw), raw }
  } catch {
    return { json: null, raw }
  }
}

export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") {
    deps.stdout(USAGE)
    return argv.length === 0 ? EXIT_USAGE : EXIT_OK
  }

  let operation: Operation
  let base: string
  let assumeYes: boolean
  let rawJson: boolean
  try {
    const built = buildCommand(argv, { newOperationId: deps.newOperationId })
    operation = built.operation
    base = apiBase(built.args.values.get("api")?.[0], deps.env)
    assumeYes = built.args.switches.has("yes")
    rawJson = built.args.switches.has("json")
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`error: ${error.message}`)
      deps.stderr("run with --help for usage")
      return EXIT_USAGE
    }
    throw error
  }

  const url = `${base}${operation.path}`
  if (operation.kind === "write") {
    for (const line of preview(operation, url)) deps.stdout(line)
    if (!assumeYes) {
      const confirmed = await deps.confirm("Send this operation? [y/N] ")
      if (!confirmed) {
        deps.stderr("Aborted; nothing was sent. (Use --yes to send non-interactively.)")
        return EXIT_FAILED
      }
    }
  }

  let token: string
  try {
    token = await resolveAccessToken({ env: deps.env, apiBase: base, run: deps.run })
  } catch (error) {
    if (error instanceof AuthError) {
      deps.stderr(`error: ${error.message}`)
      return EXIT_FAILED
    }
    throw error
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    [ACCESS_TOKEN_HEADER]: token,
  }
  if (operation.kind === "write") headers["content-type"] = "application/json"
  let response: Response
  try {
    response = await deps.fetch(url, {
      method: operation.method,
      headers,
      body: operation.kind === "write" ? JSON.stringify(operation.body) : undefined,
      redirect: "manual",
    })
  } catch (error) {
    deps.stderr(`error: request failed: ${error instanceof Error ? error.message : String(error)}`)
    if (operation.kind === "write") {
      deps.stderr(
        `The write may or may not have applied. Retry safely with --operation-id ${operation.body.operationId}`
      )
    }
    return EXIT_FAILED
  }

  const body = await readBody(response)
  if (response.status >= 300 && response.status < 400) {
    deps.stderr(
      `error: redirected (${response.status}); the Access token was not accepted at the edge. Log in again with cloudflared.`
    )
    return EXIT_FAILED
  }
  if (body.json === null) {
    deps.stderr(
      `error: unexpected non-JSON response (HTTP ${response.status}); check --api and the Access application.`
    )
    return EXIT_FAILED
  }
  if (!response.ok) {
    for (const line of renderError(response.status, body.json)) deps.stderr(line)
    return EXIT_FAILED
  }

  if (rawJson) {
    deps.stdout(JSON.stringify(body.json, null, 2))
    return EXIT_OK
  }
  if (operation.kind === "read") {
    for (const line of renderRead(operation.view, body.json)) deps.stdout(line)
    return EXIT_OK
  }
  const replayed = response.headers.get("x-idempotent-replay") === "true"
  deps.stdout(
    `OK (HTTP ${response.status})${replayed ? " — replayed: this operation ID was already applied; nothing changed" : ""}`
  )
  deps.stdout(`operationId: ${operation.body.operationId}`)
  for (const line of renderWriteResult(body.json)) deps.stdout(line)
  return EXIT_OK
}
