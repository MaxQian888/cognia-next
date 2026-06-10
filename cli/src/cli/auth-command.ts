/**
 * `cognia-agent auth <login|status|logout>` — manage provider credentials in
 * `~/.cognia/credentials.json` (0600). Keys never touch the desktop keyring.
 */

import os from "node:os"

import { resolveHome } from "../config/load"
import {
  setCredential as defaultSet,
  deleteCredential as defaultDelete,
  listCredentialProviders as defaultList,
} from "../config/credentials"
import { DEFAULT_PROVIDER } from "../config/schema"
import { stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface AuthDeps {
  home?: string
  setCredential?: typeof defaultSet
  deleteCredential?: typeof defaultDelete
  listCredentialProviders?: typeof defaultList
  out?: OutputSink
  /** Env source for the api key fallback. */
  env?: Record<string, string | undefined>
}

export async function authCommand(args: ParsedArgs, deps: AuthDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const setCredential = deps.setCredential ?? defaultSet
  const deleteCredential = deps.deleteCredential ?? defaultDelete
  const listCredentialProviders = deps.listCredentialProviders ?? defaultList

  const provider = stringFlag(args, "provider") ?? DEFAULT_PROVIDER

  switch (args.subcommand) {
    case "login": {
      const apiKey = stringFlag(args, "api-key") ?? env.COGNIA_LOGIN_API_KEY
      if (!apiKey) {
        out.error(
          `auth login: pass --api-key <key> (or set COGNIA_LOGIN_API_KEY) for provider "${provider}"`
        )
        return 2
      }
      try {
        const path = setCredential(home, provider, apiKey)
        out.write(`Saved credentials for "${provider}" to ${path}\n`)
        return 0
      } catch (err) {
        out.error(`auth login failed: ${(err as Error).message}`)
        return 1
      }
    }
    case "status": {
      const providers = listCredentialProviders(home)
      if (providers.length === 0) {
        out.write(
          "No stored credentials. Run: cognia-agent auth login --provider <id> --api-key <key>\n"
        )
      } else {
        out.write(`Stored credentials for: ${providers.join(", ")}\n`)
      }
      return 0
    }
    case "logout": {
      deleteCredential(home, provider)
      out.write(`Removed credentials for "${provider}"\n`)
      return 0
    }
    default:
      out.error("auth: expected a subcommand — login | status | logout")
      return 2
  }
}
