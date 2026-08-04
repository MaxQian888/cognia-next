import test from "node:test"
import assert from "node:assert/strict"

import {
  buildSubprocessEnv,
  childTelemetryEnv,
  isStrippedName,
  validateRouteEnv,
} from "./subprocess-env.mjs"

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

test(
  "macOS routes Claude temp files to the per-user TMPDIR",
  { skip: process.platform !== "darwin" },
  () => {
    const env = buildSubprocessEnv(
      { execution, env: {} },
      { ...hostileParent, TMPDIR: "/var/folders/user/T/" }
    )
    assert.equal(env.CLAUDE_CODE_TMPDIR, "/var/folders/user/T/")
  }
)

test(
  "an explicit Claude temp directory overrides the macOS default",
  { skip: process.platform !== "darwin" },
  () => {
    const env = buildSubprocessEnv(
      { execution, env: { CLAUDE_CODE_TMPDIR: "/session/tmp" } },
      { ...hostileParent, TMPDIR: "/var/folders/user/T/" }
    )
    assert.equal(env.CLAUDE_CODE_TMPDIR, "/session/tmp")
  }
)

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

// ---- child-process telemetry ---------------------------------------------------

const TRACED = {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces",
  OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc",
  OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=dev",
}

test("child telemetry stays off unless THIS process has a traces endpoint", () => {
  // One decision in one place. Two independent switches would eventually
  // disagree and produce a child that exports into the void.
  assert.deepEqual(childTelemetryEnv({}, {}), {})
  assert.deepEqual(childTelemetryEnv({}, { OTEL_EXPORTER_OTLP_HEADERS: "a=b" }), {})
})

test("child telemetry forwards the collector config and turns the CLI on", () => {
  const env = childTelemetryEnv({}, TRACED)
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1")
  assert.equal(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, TRACED.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
  // The headers authenticate the collector; without them the child exports and
  // is rejected, which is indistinguishable from telemetry being off.
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, "authorization=Bearer abc")
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, "deployment.environment=dev")
})

test("prompt logging is forced off in the child, never inherited", () => {
  // The sidecar's own spans are built with recordInputs/recordOutputs false.
  // A child that logged prompt bodies would break that contract from the other
  // end while looking like the same configuration.
  const env = childTelemetryEnv({}, { ...TRACED, OTEL_LOG_USER_PROMPTS: "1" })
  assert.equal(env.OTEL_LOG_USER_PROMPTS, "0")
})

test("the enhanced beta is opt-in per send, not inherited", () => {
  assert.equal(
    childTelemetryEnv({}, { ...TRACED, CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1" })
      .CLAUDE_CODE_ENHANCED_TELEMETRY_BETA,
    undefined,
    "it widens what the child records, so the parent env must not decide it"
  )
  assert.equal(
    childTelemetryEnv({ telemetry: { enhanced: true } }, TRACED)
      .CLAUDE_CODE_ENHANCED_TELEMETRY_BETA,
    "1"
  )
})

test("a send can opt out of child telemetry entirely", () => {
  assert.deepEqual(childTelemetryEnv({ telemetry: { child: false } }, TRACED), {})
})

test("a spec-carrying send gets child telemetry; a legacy one is untouched", () => {
  const traced = { ...TRACED, PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-parent" }

  const framed = buildSubprocessEnv({ execution, env: {} }, traced)
  assert.equal(framed.CLAUDE_CODE_ENABLE_TELEMETRY, "1")
  assert.equal(framed.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, TRACED.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
  // Still allowlisted: the credential in the parent env does not come back.
  assert.equal(framed.ANTHROPIC_API_KEY, undefined)
  assert.equal(framed.PATH, "/usr/bin")

  // ADR-0090 constraint 6: the legacy spread is byte-identical to before, and
  // the parent's OTEL_* already rides along in it anyway.
  const legacy = buildSubprocessEnv({ env: {} }, traced)
  assert.deepEqual(legacy, traced)
})

test("the spec overlay still outranks the host telemetry block", () => {
  const framed = buildSubprocessEnv(
    { execution, env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://spec:4318/v1/traces" } },
    TRACED
  )
  assert.equal(framed.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "http://spec:4318/v1/traces")
})

test("OTEL_* and CLAUDE_* still never arrive by inheritance", () => {
  // With no endpoint configured the telemetry block is empty, so the only
  // remaining path is the allowlist — which excludes both prefixes.
  const framed = buildSubprocessEnv(
    { execution, env: {} },
    { OTEL_SERVICE_NAME: "leaked", CLAUDE_CODE_ENABLE_TELEMETRY: "1", PATH: "/usr/bin" }
  )
  assert.deepEqual(framed, { PATH: "/usr/bin" })
})
