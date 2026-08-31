import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

const AGENT_ENVIRONMENT_KEYS = [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG_DIR",
  "CCSWITCH_HOME",
]

/**
 * Creates a fail-closed guard for subscription/account simulations.
 *
 * The guard never inspects process.env or a credential store. Callers must pass
 * a unique temporary root and explicitly inject the returned environment into
 * the mocked operation under test.
 */
export function createSubscriptionSimulationBoundary(temporaryRoot) {
  if (!isAbsolute(temporaryRoot)) {
    throw new Error("Subscription simulation root must be an absolute temporary path")
  }

  const root = canonicalizeExistingPath(temporaryRoot)

  const assertTemporaryPath = (candidate) => {
    if (!isAbsolute(candidate)) {
      throw new Error(`Subscription simulation path must be absolute: ${candidate}`)
    }

    const resolved = canonicalizeExistingPath(candidate)
    const relativePath = relative(root, resolved)
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Subscription simulation blocked non-temporary path: ${candidate}`)
    }
    return resolved
  }

  const assertFixtureEndpoint = (endpoint) => {
    if (endpoint.startsWith("in-process:")) return endpoint

    const url = new URL(endpoint)
    const isLoopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
    if (url.protocol !== "http:" || !isLoopback) {
      throw new Error(`Subscription simulation blocked public network endpoint: ${endpoint}`)
    }
    return url.toString()
  }

  const assertCredentialAdapter = (adapter) => {
    if (adapter !== "memory" && adapter !== "fixture") {
      throw new Error(`Subscription simulation blocked credential adapter: ${adapter}`)
    }
    return adapter
  }

  const environment = Object.fromEntries(
    AGENT_ENVIRONMENT_KEYS.map((key) => [
      key,
      assertTemporaryPath(resolve(root, key.toLowerCase())),
    ])
  )

  return {
    temporaryRoot: root,
    environment,
    assertTemporaryPath,
    assertFixtureEndpoint,
    assertCredentialAdapter,
  }
}

function canonicalizeExistingPath(path) {
  const resolved = resolve(path)
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved
}
