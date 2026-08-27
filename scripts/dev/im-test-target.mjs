#!/usr/bin/env node
//
// Start the desktop app with its model endpoint pointed at a deterministic
// fixture, so `pnpm im:test:live` can prove a prompt actually reached the model
// rather than trusting that a reply appeared.
//
//   pnpm im:test:target
//
// What it deliberately does NOT do: touch the user's database, keyring, or
// connector configuration. The whole point is to exercise the bots the operator
// already has running, so the only thing this changes is the environment the
// Tauri process is launched with.
//
// Two things can still route the model call away from the fixture, and neither
// is visible from here:
//   * a provider configured in the vault supplies its own base URL or an OAuth
//     bearer (`src-tauri/src/claude/host.rs` inject_provider_env), and
//   * a turn carrying a frozen execution spec has its subprocess environment
//     rebuilt from an allowlist (`sidecar/dispatch/subprocess-env.mjs`).
// Both are caught after the fact: a reply with no matching fixture request is
// reported as MODEL_NOT_INTERCEPTED rather than passing quietly.
//
// Exit code is the Tauri process's own.

import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { DEFAULT_OUTPUT_DIR } from "../smoke/im-live/config.mjs"
import { runTauri } from "./tauri.mjs"

/** Where the runner looks for us. Kept in step with `fixture-client.mjs`. */
export function handshakeFile(outputDir = DEFAULT_OUTPUT_DIR) {
  return path.join(outputDir, "target.json")
}

/**
 * The environment the Tauri process is launched with.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is dropped for the same reason
 * `tests/e2e/helpers/tauri-cdp-launch.ts` drops it: the Agent SDK prefers a
 * bearer over the API key and would route past the fixture's base URL. Mixing
 * the two auth modes is undefined behaviour, so we pick one.
 */
export function buildTargetEnv(baseEnv, { baseUrl, apiKey, controlToken }) {
  const env = { ...baseEnv }
  env.ANTHROPIC_BASE_URL = baseUrl
  env.ANTHROPIC_API_KEY = apiKey
  env.E2E_ANTHROPIC_CONTROL_TOKEN = controlToken
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

export function handshakePayload({ baseUrl, controlToken, pid = process.pid, startedAt }) {
  return { schema: "cognia.im-live.target/1", baseUrl, controlToken, pid, startedAt }
}

/**
 * Publish the handshake at 0600.
 *
 * It holds the control token, which is the only thing standing between a local
 * process and the fixture's request log, so it is never world-readable.
 */
export function writeHandshake(outputDir, payload, fs = { mkdirSync, writeFileSync }) {
  const file = handshakeFile(outputDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    // Windows ignores the mode; on POSIX this keeps the token to the operator.
    mode: 0o600,
  })
  return file
}

export function removeHandshake(outputDir, fs = { rmSync }) {
  fs.rmSync(handshakeFile(outputDir), { force: true })
}

export async function startTarget({
  outputDir = DEFAULT_OUTPUT_DIR,
  env = process.env,
  log = console.log,
  createFixture,
  runTauriImpl = runTauri,
  now = Date.now,
  makeToken = () => randomBytes(24).toString("hex"),
  onCleanup = (fn) => {
    process.once("SIGINT", fn)
    process.once("SIGTERM", fn)
  },
} = {}) {
  const controlToken = makeToken()
  // The fixture reads this at request time to guard `/__control/*`; set it
  // before starting so the very first control call is already protected.
  process.env.E2E_ANTHROPIC_CONTROL_TOKEN = controlToken

  const fixture = await createFixture()
  const payload = handshakePayload({ baseUrl: fixture.baseUrl, controlToken, startedAt: now() })
  const file = writeHandshake(outputDir, payload)

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeHandshake(outputDir)
  }
  onCleanup(cleanup)

  log(`[im-test-target] model fixture on ${fixture.baseUrl} (loopback only)`)
  log(`[im-test-target] handshake at ${file}`)
  log("[im-test-target] starting the desktop app — leave this running, then in another terminal:")
  log("[im-test-target]   pnpm im:test:doctor -- --platform <name>")
  log("[im-test-target]   pnpm im:test:live   -- --platform <name>")

  try {
    const result = await runTauriImpl(["dev"], {
      env: buildTargetEnv(env, {
        baseUrl: fixture.baseUrl,
        apiKey: env.IM_LIVE_FIXTURE_API_KEY || "im-live-fixture-key",
        controlToken,
      }),
    })
    return result.code ?? 1
  } finally {
    cleanup()
    await fixture.stop().catch(() => undefined)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The fixture is TypeScript and reaches for a bare `require("express")`,
  // because its other consumers (Playwright global-setup, Jest) load it as
  // CommonJS. Node strips the types and loads it as ESM, where `require` is not
  // a global — supply one rather than changing a module system two green suites
  // already depend on.
  const { createRequire: makeRequire } = await import("node:module")
  globalThis.require ??= makeRequire(import.meta.url)
  const { createMockAnthropicServer } = await import("../../tests/e2e/mocks/anthropic/server.ts")

  process.exitCode = await startTarget({
    createFixture: async () => {
      const server = createMockAnthropicServer()
      await server.start(0)
      return server
    },
  })
}
