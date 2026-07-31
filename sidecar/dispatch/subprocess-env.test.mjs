import test from "node:test"
import assert from "node:assert/strict"

import { buildSubprocessEnv, isStrippedName, validateRouteEnv } from "./subprocess-env.mjs"

const execution = {
  specVersion: 1,
  executionFingerprint: "aexf1-x",
  runtimeAdapter: "claude-agent-sdk",
  executionKind: "agent",
  route: { kind: "direct" },
  modelBindings: { primary: "claude-sonnet-5" },
  capabilities: { effective: [], disabledOptional: [] },
  identity: { runId: "r1", attemptId: "a1" },
  hostRef: "desktop-sidecar",
}

const hostileParent = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  LANG: "en_US.UTF-8",
  ANTHROPIC_API_KEY: "sk-parent-leak",
  ANTHROPIC_BASE_URL: "https://evil.example",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-parent-leak",
  CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
  OPENAI_API_KEY: "sk-openai-leak",
  AWS_SECRET_ACCESS_KEY: "aws-leak",
  HTTPS_PROXY: "http://proxy.corp:8080",
  MY_VENDOR_API_KEY: "sk-vendor-leak",
  RANDOM_HARMLESS: "but-not-allowlisted",
}

test("spec sessions strip every inherited credential/route/proxy var", () => {
  const env = buildSubprocessEnv({ execution, env: {} }, hostileParent)
  assert.equal(env.PATH, "/usr/bin")
  assert.equal(env.HOME, "/Users/dev")
  assert.equal(env.LANG, "en_US.UTF-8")
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "OPENAI_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "HTTPS_PROXY",
    "MY_VENDOR_API_KEY",
    "RANDOM_HARMLESS",
  ]) {
    assert.equal(env[name], undefined, `${name} must not be inherited`)
  }
})

test("the spec env overlay is authoritative and re-adds only what it declares", () => {
  const env = buildSubprocessEnv(
    {
      execution,
      env: {
        ANTHROPIC_API_KEY: "sk-cognia-rt-ticket",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:47823/v1",
        HTTPS_PROXY: "http://spec-approved-proxy:1",
      },
    },
    hostileParent
  )
  assert.equal(env.ANTHROPIC_API_KEY, "sk-cognia-rt-ticket")
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47823/v1")
  assert.equal(env.HTTPS_PROXY, "http://spec-approved-proxy:1")
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test("legacy sessions (no execution spec) keep the historical spread", () => {
  const env = buildSubprocessEnv({ env: { EXTRA: "1" } }, hostileParent)
  // Byte-for-byte legacy behavior: inherited creds INTENTIONALLY survive
  // because the desktop host injects them into the sidecar process env.
  assert.equal(env.ANTHROPIC_API_KEY, "sk-parent-leak")
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-parent-leak")
  assert.equal(env.EXTRA, "1")
})

test("concurrent sessions with different spec envs never cross-bleed", () => {
  const a = buildSubprocessEnv(
    { execution, env: { ANTHROPIC_API_KEY: "sk-session-A" } },
    hostileParent
  )
  const b = buildSubprocessEnv(
    { execution, env: { ANTHROPIC_API_KEY: "sk-session-B" } },
    hostileParent
  )
  assert.equal(a.ANTHROPIC_API_KEY, "sk-session-A")
  assert.equal(b.ANTHROPIC_API_KEY, "sk-session-B")
  // Building B did not mutate A (fresh objects, no shared state).
  assert.notEqual(a, b)
})

test("isStrippedName classifies the documented dangerous classes", () => {
  for (const name of [
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_ENTRYPOINT",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_ENDPOINT",
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENROUTER_API_KEY",
    "AWS_SESSION_TOKEN",
    "NO_PROXY",
    "SOME_VENDOR_SECRET",
    "GH_TOKEN",
  ]) {
    assert.equal(isStrippedName(name), true, name)
  }
  for (const name of ["PATH", "HOME", "MY_FEATURE_FLAG"]) {
    assert.equal(isStrippedName(name), false, name)
  }
})

test("validateRouteEnv rejects a gateway route whose overlay smuggles a foreign base URL", () => {
  const gatewayExecution = {
    ...execution,
    route: { kind: "gateway", endpoint: "http://127.0.0.1:47823/v1", ticketId: "tk-1" },
  }
  assert.deepEqual(
    validateRouteEnv({
      execution: gatewayExecution,
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:47823/v1" },
    }),
    { ok: true }
  )
  const smuggled = validateRouteEnv({
    execution: gatewayExecution,
    env: { ANTHROPIC_BASE_URL: "https://evil.example" },
  })
  assert.equal(smuggled.ok, false)
  // Direct routes and legacy sends don't constrain the base URL here.
  assert.deepEqual(validateRouteEnv({ execution, env: {} }), { ok: true })
  assert.deepEqual(validateRouteEnv({ env: {} }), { ok: true })
})
