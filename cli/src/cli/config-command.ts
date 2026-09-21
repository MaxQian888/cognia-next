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
  setAgentBackendModel as defaultSetAgentBackendModel,
  setBackendExtensionPolicy as defaultSetBackendExtensionPolicy,
  setConfigValue as defaultSet,
  setProviderBaseURL as defaultSetProviderBaseURL,
  setProviderModel as defaultSetProviderModel,
} from "../config/mutate"
import type { CliConfigFile } from "../config/schema"
import { type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"

export interface ConfigDeps {
  home?: string
  loadConfig?: (flags?: Partial<CliConfigFile>) => ReturnType<typeof defaultLoadConfig>
  setConfigValue?: typeof defaultSet
  setProviderBaseURL?: typeof defaultSetProviderBaseURL
  setProviderModel?: typeof defaultSetProviderModel
  setAgentBackendModel?: typeof defaultSetAgentBackendModel
  setBackendExtensionPolicy?: typeof defaultSetBackendExtensionPolicy
  out?: OutputSink
  env?: Record<string, string | undefined>
}

/** Matches the nested `set` path `providers.<id>.baseURL`. */
const PROVIDER_BASE_URL_KEY = /^providers\.([^.]+)\.baseURL$/

/** Matches the nested `set` path `providers.<id>.model` (per-provider model memory). */
const PROVIDER_MODEL_KEY = /^providers\.([^.]+)\.model$/

/**
 * Matches `agentBackends.<preset>.model` — the model one external agent
 * backend remembers (`agentBackends[presetId].model`). Routed to the backend
 * writer rather than the provider one: an external agent is not a chat
 * provider, and sharing the record would rewrite the built-in sidecar's model.
 */
const BACKEND_MODEL_KEY = /^agentBackends\.([^.]+)\.model$/

/**
 * Matches `agentBackends.<preset>.piExtensionPolicy` — how much of the user's
 * own Pi stack a Cognia Pi session loads (ADR-0119). The one external-backend
 * setting that is not a model, and the one a user has to be able to change:
 * an isolated session cannot see a provider that a Pi extension contributes.
 */
const BACKEND_EXTENSION_POLICY_KEY = /^agentBackends\.([^.]+)\.piExtensionPolicy$/

/**
 * Resolve a `config get` key against the redacted resolved config. Top-level
 * keys resolve directly; dotted keys (`agentBackends.pi-rpc.model`,
 * `providers.deepseek.baseURL`, `statusBar.theme`) walk nested objects, so
 * every path `config set` writes is also readable. Own-property lookup only —
 * `constructor.prototype`-style segments must not reach the prototype chain.
 */
function lookupConfigValue(root: Record<string, unknown>, key: string): unknown {
  let value: unknown = root
  for (const segment of key.split(".")) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, segment)
    ) {
      return undefined
    }
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

export async function configCommand(args: ParsedArgs, deps: ConfigDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput
  const env = deps.env ?? process.env
  const home = deps.home ?? resolveHome(env, os.homedir())
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  const setConfigValue = deps.setConfigValue ?? defaultSet
  const setProviderBaseURL = deps.setProviderBaseURL ?? defaultSetProviderBaseURL
  const setProviderModel = deps.setProviderModel ?? defaultSetProviderModel
  const setAgentBackendModel = deps.setAgentBackendModel ?? defaultSetAgentBackendModel
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
        const value = lookupConfigValue(redacted, key)
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
      const providerModelMatch = key.match(PROVIDER_MODEL_KEY)
      const backendModelMatch = key.match(BACKEND_MODEL_KEY)
      const backendPolicyMatch = key.match(BACKEND_EXTENSION_POLICY_KEY)
      try {
        if (providerBaseURLMatch) {
          const path = setProviderBaseURL(home, providerBaseURLMatch[1], value)
          out.write(`Set ${key} in ${path}\n`)
          return 0
        }
        if (providerModelMatch) {
          const path = setProviderModel(home, providerModelMatch[1], value)
          out.write(`Set ${key} in ${path}\n`)
          return 0
        }
        if (backendModelMatch) {
          const path = setAgentBackendModel(home, backendModelMatch[1], value)
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
