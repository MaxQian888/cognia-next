/**
 * `cognia-agent logto <login|status|logout>` — obtain and manage a Logto OIDC
 * session for the cloud/headless multi-user deployment (ADR-0059).
 *
 * `login` runs the authorization-code + PKCE flow: it stands up a loopback
 * callback server (`../mcp/oauth-callback-server`), opens the browser
 * (`../mcp/open-browser`), and hands both to the runtime-agnostic
 * `loginToLogto` (`@/lib/logto/client`). The resulting access token — a JWT the
 * companion gateway validates — is stored in `~/.cognia/logto.json` (0600).
 * Everything is injected so the command unit-tests without sockets or a browser.
 */

import os from "node:os"

import {
  loginToLogto as defaultLogin,
  revokeLogtoToken as defaultRevoke,
  type LogtoClientConfig,
  type LogtoDrivers,
} from "@/lib/logto/client"

import { resolveHome } from "../config/load"
import {
  writeLogtoSessionFile,
  readLogtoSessionFile,
  removeLogtoSessionFile,
  type LogtoSessionFs,
} from "../config/logto-session"
import { startCallbackServer as defaultStartCallback } from "../mcp/oauth-callback-server"
import { openBrowser as defaultOpenBrowser } from "../mcp/open-browser"

import { stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

/** Default wait for the browser round-trip: 3 minutes. */
const DEFAULT_TIMEOUT_MS = 3 * 60_000

export interface LogtoCommandDeps {
  home?: string
  env?: Record<string, string | undefined>
  out?: OutputSink
  login?: typeof defaultLogin
  revoke?: typeof defaultRevoke
  fetchImpl?: typeof fetch
  now?: () => number
  startCallbackServer?: typeof defaultStartCallback
  openBrowser?: typeof defaultOpenBrowser
  sessionFs?: LogtoSessionFs
  timeoutMs?: number
}

export async function logtoCommand(args: ParsedArgs, deps: LogtoCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())

  switch (args.subcommand) {
    case "login":
      return loginSub(args, deps, out, env, home)
    case "status":
      return statusSub(deps, out, home)
    case "logout":
      return logoutSub(deps, out, home)
    default:
      out.error("logto: expected a subcommand — login | status | logout")
      return 2
  }
}

async function loginSub(
  args: ParsedArgs,
  deps: LogtoCommandDeps,
  out: OutputSink,
  env: Record<string, string | undefined>,
  home: string
): Promise<number> {
  const issuer = stringFlag(args, "issuer") ?? env.COGNIA_LOGTO_ISSUER
  const clientId = stringFlag(args, "client-id") ?? env.COGNIA_LOGTO_CLIENT_ID
  const resource = stringFlag(args, "resource") ?? env.COGNIA_LOGTO_AUDIENCE
  if (!issuer || !clientId || !resource) {
    out.error(
      "logto login: --issuer, --client-id and --resource are required " +
        "(or set COGNIA_LOGTO_ISSUER / COGNIA_LOGTO_CLIENT_ID / COGNIA_LOGTO_AUDIENCE)"
    )
    return 2
  }
  const scopesRaw = stringFlag(args, "scope") ?? env.COGNIA_LOGTO_SCOPES
  const scopes = scopesRaw ? scopesRaw.split(/[,\s]+/).filter(Boolean) : undefined
  const organizationId = stringFlag(args, "org") ?? env.COGNIA_LOGTO_ORG

  const startCallbackServer = deps.startCallbackServer ?? defaultStartCallback
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const login = deps.login ?? defaultLogin
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const server = await startCallbackServer({})
  try {
    const config: LogtoClientConfig = {
      issuer,
      clientId,
      redirectUri: server.redirectUrl,
      resource,
      scopes,
      organizationId,
    }
    const drivers: LogtoDrivers = {
      openUrl: async (url) => {
        const opened = await openBrowser(url)
        if (!opened) out.write(`Open this URL to sign in:\n  ${url}\n`)
      },
      waitForCode: async () => {
        const result = await server.waitForCode(timeoutMs)
        if (!result.code || !result.state) {
          throw new Error("Logto callback did not return a code")
        }
        return { code: result.code, state: result.state }
      },
    }
    const session = await login(config, drivers)
    writeLogtoSessionFile(home, session, deps.sessionFs)
    out.write(
      `Signed in to Logto (resource ${session.resource}` +
        `${session.organizationId ? `, org ${session.organizationId}` : ""}).\n` +
        `Saved session to ${home}/logto.json\n`
    )
    return 0
  } catch (err) {
    out.error(`logto login failed: ${(err as Error).message}`)
    return 1
  } finally {
    server.close()
  }
}

/**
 * Revoke at the issuer, then remove the file. Revocation is best effort and
 * reported: the file is removed whether or not the issuer could be reached,
 * because a token this process has forgotten but the issuer still honours is
 * the worse of the two outcomes to hide.
 */
async function logoutSub(deps: LogtoCommandDeps, out: OutputSink, home: string): Promise<number> {
  const session = readLogtoSessionFile(home, deps.sessionFs)
  if (!session) {
    out.write("Not signed in to Logto; nothing to sign out of.\n")
    return 0
  }
  const revoke = deps.revoke ?? defaultRevoke
  const outcomes = []
  if (session.refreshToken) {
    outcomes.push(await revoke(session, session.refreshToken, "refresh_token", deps.fetchImpl))
  }
  outcomes.push(await revoke(session, session.accessToken, "access_token", deps.fetchImpl))
  removeLogtoSessionFile(home, deps.sessionFs)
  const failed = outcomes.find((outcome) => outcome.status === "failed")
  if (failed && failed.status === "failed") {
    out.write(
      "Signed out of Logto (removed logto.json), but the issuer could not be told to " +
        `revoke the token: ${failed.reason}\n`
    )
    return 0
  }
  if (outcomes.some((outcome) => outcome.status === "unsupported")) {
    out.write(
      "Signed out of Logto (removed logto.json). The issuer advertises no revocation " +
        "endpoint, so the token expires on its own schedule.\n"
    )
    return 0
  }
  out.write("Signed out of Logto (removed logto.json; tokens revoked at the issuer).\n")
  return 0
}

function statusSub(deps: LogtoCommandDeps, out: OutputSink, home: string): number {
  const session = readLogtoSessionFile(home, deps.sessionFs)
  if (!session) {
    out.write(
      "Not signed in to Logto. Run: " +
        "cognia-agent logto login --issuer <url> --client-id <id> --resource <api>\n"
    )
    return 0
  }
  const now = (deps.now ?? Date.now)()
  const expired = session.expiresAt !== undefined && session.expiresAt <= now
  const expires = session.expiresAt ? new Date(session.expiresAt).toISOString() : "unknown"
  const heading = expired
    ? session.refreshToken
      ? "Signed in to Logto (access token expired; will refresh on next use)\n"
      : "Logto session expired; run `cognia-agent logto login` again\n"
    : "Signed in to Logto\n"
  out.write(
    heading +
      `  issuer:   ${session.issuer}\n` +
      `  resource: ${session.resource}\n` +
      `  org:      ${session.organizationId ?? "-"}\n` +
      `  scopes:   ${session.scopes.join(" ") || "-"}\n` +
      `  expires:  ${expires}\n`
  )
  return 0
}
