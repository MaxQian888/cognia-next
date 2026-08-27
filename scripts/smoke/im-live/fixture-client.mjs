// Client for the deterministic model fixture's control plane.
//
// This is the harness's *first* piece of evidence, and the more important of
// the two. The platform reply only proves that something answered; the fixture
// request log proves the answer came from the fixture rather than from the
// user's real provider — see `MODEL_NOT_INTERCEPTED` in `diagnose.mjs`.
//
// The fixture is booted by `pnpm im:test:target`, which writes its URL and
// one-shot control token to `<outputDir>/target.json`. Everything here talks
// plain HTTP so the runner stays a separate process from the app under test.

import { readFile } from "node:fs/promises"
import path from "node:path"

import { DEFAULT_OUTPUT_DIR } from "./config.mjs"

/** Where `pnpm im:test:target` publishes its handshake. */
export function targetHandshakePath(outputDir = DEFAULT_OUTPUT_DIR) {
  return path.join(outputDir, "target.json")
}

export class FixtureUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = "FixtureUnavailableError"
  }
}

/**
 * Resolve the fixture endpoint.
 *
 * Explicit env wins (`IM_LIVE_FIXTURE_URL` / `IM_LIVE_FIXTURE_TOKEN`) so a CI
 * job can point at a fixture it started itself; otherwise the handshake file
 * is the source of truth.
 */
export async function discoverFixture(config, { readFileImpl = readFile } = {}) {
  if (config.fixtureUrl) {
    return {
      baseUrl: stripTrailingSlash(config.fixtureUrl),
      token: config.fixtureToken,
      source: "env",
    }
  }
  const file = targetHandshakePath(config.outputDir)
  let raw
  try {
    raw = await readFileImpl(file, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new FixtureUnavailableError(
        `no model fixture found at ${file}. Start the target first: \`pnpm im:test:target\` ` +
          `(or set IM_LIVE_FIXTURE_URL for a fixture you booted yourself).`
      )
    }
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new FixtureUnavailableError(
      `${file} is not valid JSON — stop and restart pnpm im:test:target`
    )
  }
  if (!parsed?.baseUrl) {
    throw new FixtureUnavailableError(
      `${file} has no baseUrl — stop and restart pnpm im:test:target`
    )
  }
  return {
    baseUrl: stripTrailingSlash(parsed.baseUrl),
    token: parsed.controlToken ?? "",
    source: file,
  }
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "")
}

export function createFixtureClient({ baseUrl, token = "", fetchImpl = fetch, now = Date.now }) {
  const root = stripTrailingSlash(baseUrl)
  const headers = token ? { "x-cognia-control-token": token } : {}

  async function call(pathname, init = {}) {
    let response
    try {
      response = await fetchImpl(`${root}${pathname}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      })
    } catch (error) {
      throw new FixtureUnavailableError(
        `model fixture at ${root} is unreachable (${error?.message ?? error}). ` +
          `Is \`pnpm im:test:target\` still running?`
      )
    }
    if (response.status === 401) {
      throw new FixtureUnavailableError(
        `model fixture at ${root} rejected the control token. The runner and the target ` +
          `disagree — restart \`pnpm im:test:target\` and re-run.`
      )
    }
    if (!response.ok) {
      throw new FixtureUnavailableError(
        `model fixture ${pathname} answered HTTP ${response.status}`
      )
    }
    return response.json()
  }

  return {
    baseUrl: root,

    /** Drop every captured request so a run only ever sees its own traffic. */
    async reset() {
      await call("/__control/reset", { method: "POST" })
    },

    /** Redacted request log. Never contains prompt text — see `redactMessagesHit`. */
    async requests() {
      return call("/__control/requests")
    },

    /** Cheap liveness probe for `doctor`. */
    async probe() {
      const log = await this.requests()
      return { ok: true, count: log.count ?? 0 }
    },

    /**
     * Wait until a captured request carries `marker`.
     *
     * Resolves with the hit, or `null` on timeout — a timeout is a legitimate
     * outcome that `diagnose.mjs` interprets alongside the platform reply, not
     * an exception.
     */
    async waitForMarker(marker, { timeoutMs, pollMs = 750, signal, sleep = defaultSleep } = {}) {
      const deadline = now() + timeoutMs
      for (;;) {
        if (signal?.aborted) return null
        const log = await this.requests()
        const hit = (log.hits ?? []).find((entry) => (entry.markers ?? []).includes(marker))
        if (hit) return hit
        if (now() >= deadline) return null
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
      }
    },
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
