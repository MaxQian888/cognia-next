/**
 * `cognia-agent logto <login|status|logout>` — obtain and manage an OIDC
 * session: the official Cognia account by default (ADR-0215), or a
 * self-hosted Logto deployment (ADR-0059) when its issuer is named.
 *
 * `login` with no issuer configured signs in to the official account with the
 * first-party `cognia-app` client; `--provider feishu|github|google|apple`
 * goes straight to that provider, and `COGNIA_ID_ISSUER` /
 * `COGNIA_ID_AUDIENCE` point it at staging or a local identity Worker.
 * `--issuer`, `--client-id` and `--resource` (or `COGNIA_LOGTO_*`) together
 * select a self-hosted Logto instead; naming only some of them is an error.
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

import {
  isOfficialSocialProvider,
  officialDeployment,
  officialLogtoConfig,
  OFFICIAL_SOCIAL_PROVIDERS,
} from "@/lib/identity/official-deployment"

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
  const provider = stringFlag(args, "provider")
  const official = !issuer && !clientId && !resource
  if (!official && (!issuer || !clientId || !resource)) {
    out.error(
      "logto login: --issuer, --client-id and --resource go together " +
        "(or set COGNIA_LOGTO_ISSUER / COGNIA_LOGTO_CLIENT_ID / COGNIA_LOGTO_AUDIENCE); " +
        "name none of them to sign in to the official Cognia account"
    )
    return 2
  }
  if (provider && (!official || !isOfficialSocialProvider(provider))) {
    out.error(
      official
        ? `logto login: --provider must be one of ${OFFICIAL_SOCIAL_PROVIDERS.join(", ")}`
        : "logto login: --provider applies to the official Cognia account only"
    )
    return 2
  }
  const scopesRaw = stringFlag(args, "scope") ?? env.COGNIA_LOGTO_SCOPES
  const scopes = scopesRaw ? scopesRaw.split(/[,\s]+/).filter(Boolean) : undefined
  const organizationId = stringFlag(args, "org") ?? env.COGNIA_LOGTO_ORG
  if (official && (organizationId || scopes)) {
    out.error(
      "logto login: --org and --scope (COGNIA_LOGTO_ORG / COGNIA_LOGTO_SCOPES) apply to a " +
        "self-hosted Logto deployment only"
    )
    return 2
  }

  const startCallbackServer = deps.startCallbackServer ?? defaultStartCallback
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const login = deps.login ?? defaultLogin
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const server = await startCallbackServer({})
  try {
    const config: LogtoClientConfig = official
      ? officialLogtoConfig(
          // Always on for the CLI: the self-hosted web image's build flag
          // does not apply here, and COGNIA_ID_* replace the defaults.
          officialDeployment({ issuer: env.COGNIA_ID_ISSUER, audience: env.COGNIA_ID_AUDIENCE })!,
          {
            redirectUri: server.redirectUrl,
            clientKind: "native",
            ...(provider && isOfficialSocialProvider(provider) ? { socialProvider: provider } : {}),
          }
        )
      : {
          issuer: issuer!,
          clientId: clientId!,
          redirectUri: server.redirectUrl,
          resource: resource!,
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
      `Signed in to ${accountName(session)} (resource ${session.resource}` +
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

/** What to call the account a session belongs to. */
function accountName(session: { issuerKind?: string }): string {
  return session.issuerKind === "oidc" ? "your Cognia account" : "Logto"
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
    out.write("Not signed in; nothing to sign out of.\n")
    return 0
  }
  const name = accountName(session)
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
      `Signed out of ${name} (removed logto.json), but the issuer could not be told to ` +
        `revoke the token: ${failed.reason}\n`
    )
    return 0
  }
  if (outcomes.some((outcome) => outcome.status === "unsupported")) {
    out.write(
      `Signed out of ${name} (removed logto.json). The issuer advertises no revocation ` +
        "endpoint, so the token expires on its own schedule.\n"
    )
    return 0
  }
  if (outcomes.some((outcome) => outcome.status === "self-expiring")) {
    out.write(
      `Signed out of ${name} (removed logto.json; the session is revoked at the issuer, ` +
        "and the short-lived access token expires on its own).\n"
    )
    return 0
  }
  out.write(`Signed out of ${name} (removed logto.json; tokens revoked at the issuer).\n`)
  return 0
}

function statusSub(deps: LogtoCommandDeps, out: OutputSink, home: string): number {
  const session = readLogtoSessionFile(home, deps.sessionFs)
  if (!session) {
    out.write(
      "Not signed in. Run: cognia-agent logto login [--provider feishu|github|google|apple]\n" +
        "  (or, for a self-hosted Logto: --issuer <url> --client-id <id> --resource <api>)\n"
    )
    return 0
  }
  const now = (deps.now ?? Date.now)()
  const expired = session.expiresAt !== undefined && session.expiresAt <= now
  const expires = session.expiresAt ? new Date(session.expiresAt).toISOString() : "unknown"
  const name = accountName(session)
  const heading = expired
    ? session.refreshToken
      ? `Signed in to ${name} (access token expired; will refresh on next use)\n`
      : `Session for ${name} expired; run \`cognia-agent logto login\` again\n`
    : `Signed in to ${name}\n`
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
