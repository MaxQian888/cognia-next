/**
 * `cognia-agent config <get|set|path>` — inspect / edit the standalone config.
 */

import os from "node:os"

import {
  resolveHome,
  userConfigPath,
  credentialsPath,
  loadConfig as defaultLoadConfig,
} from "../config/load"
import {
  setBackendExtensionPolicy as defaultSetBackendExtensionPolicy,
  setConfigValue as defaultSet,
  setProviderBaseURL as defaultSetProviderBaseURL,
} from "../config/mutate"
import type { CliConfigFile } from "../config/schema"
import { type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface ConfigDeps {
  home?: string
  loadConfig?: (flags?: Partial<CliConfigFile>) => ReturnType<typeof defaultLoadConfig>
  setConfigValue?: typeof defaultSet
  setProviderBaseURL?: typeof defaultSetProviderBaseURL
  setBackendExtensionPolicy?: typeof defaultSetBackendExtensionPolicy
  out?: OutputSink
  env?: Record<string, string | undefined>
}

/** Matches the nested `set` path `providers.<id>.baseURL`. */
const PROVIDER_BASE_URL_KEY = /^providers\.([^.]+)\.baseURL$/

/**
 * Matches `agentBackends.<preset>.piExtensionPolicy` — how much of the user's
 * own Pi stack a Cognia Pi session loads (ADR-0119). The one external-backend
 * setting that is not a model, and the one a user has to be able to change:
 * an isolated session cannot see a provider that a Pi extension contributes.
 */
const BACKEND_EXTENSION_POLICY_KEY = /^agentBackends\.([^.]+)\.piExtensionPolicy$/

export async function configCommand(args: ParsedArgs, deps: ConfigDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  const setConfigValue = deps.setConfigValue ?? defaultSet
  const setProviderBaseURL = deps.setProviderBaseURL ?? defaultSetProviderBaseURL
  const setBackendExtensionPolicy =
    deps.setBackendExtensionPolicy ?? defaultSetBackendExtensionPolicy

  switch (args.subcommand) {
    case "path": {
      out.write(`config:      ${userConfigPath(home)}\n`)
      out.write(`credentials: ${credentialsPath(home)}\n`)
      return 0
    }
    case "get": {
      let config: ReturnType<typeof defaultLoadConfig>
      try {
        config = loadConfig()
      } catch (err) {
        out.error(`config error: ${(err as Error).message}`)
        return 2
      }
      // Never print secrets — redact provider API keys and subscription tokens.
      const redacted = {
        ...config,
        providers: Object.fromEntries(
          Object.entries(config.providers).map(([id, p]) => [
            id,
            {
              ...p,
              apiKey: p.apiKey ? "***" : undefined,
              authToken: p.authToken ? "***" : undefined,
            },
          ])
        ),
      }
      const key = args.positionals[0]
      if (key) {
        const value = (redacted as Record<string, unknown>)[key]
        if (value === undefined) {
          out.error(`config get: unknown key "${key}"`)
          return 2
        }
        out.write(typeof value === "string" ? value + "\n" : JSON.stringify(value, null, 2) + "\n")
      } else {
        out.json(redacted)
      }
      return 0
    }
    case "set": {
      const [key, ...rest] = args.positionals
      const value = rest.join(" ")
      if (!key || !value) {
        out.error("config set: usage — config set <key> <value>")
        return 2
      }
      const providerBaseURLMatch = key.match(PROVIDER_BASE_URL_KEY)
      const backendPolicyMatch = key.match(BACKEND_EXTENSION_POLICY_KEY)
      try {
        if (providerBaseURLMatch) {
          const path = setProviderBaseURL(home, providerBaseURLMatch[1], value)
          out.write(`Set ${key} in ${path}\n`)
          return 0
        }
        if (backendPolicyMatch) {
          const path = setBackendExtensionPolicy(home, backendPolicyMatch[1], value)
          out.write(`Set ${key} in ${path}\n`)
          return 0
        }
        const path = setConfigValue(home, key, value)
        out.write(`Set ${key} in ${path}\n`)
        return 0
      } catch (err) {
        out.error(`config set failed: ${(err as Error).message}`)
        return 2
      }
    }
    default:
      out.error("config: expected a subcommand — get | set | path")
      return 2
  }
}
