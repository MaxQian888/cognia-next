import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ProjectEnvironment,
  ProjectEnvironmentBootstrapAgent,
} from "@/types/project-environment"
import {
  assertBootstrapAgent,
  assertBootstrapEnvironment,
  BOOTSTRAP_CONFIG_ENV,
  BOOTSTRAP_BINARY_ENV,
  prepareBootstrapExecution,
  parseBootstrapAdvancedOptions,
} from "./bootstrap-agent"

const agent: ProjectEnvironmentBootstrapAgent = {
  enabled: true,
  task: "Install missing dependencies",
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  checks: [{ name: "ready", command: "test -d node_modules" }],
}
const environment: ProjectEnvironment = {
  id: "env",
  projectId: "project",
  name: "Development",
  isEnabled: true,
  setupScript: { default: "pnpm install", byOs: { macos: "brew install node", linux: "npm ci" } },
  actions: [],
  variables: { MODE: "test" },
  keyringReferences: [{ variable: "COGNIA_BOOTSTRAP_API_KEY", keyringRef: "provider:test" }],
  bootstrapAgent: agent,
  createdAt: 1,
  updatedAt: 1,
}

it("prepares immutable host-specific configuration with credentials referenced by name", () => {
  const before = structuredClone(environment)
  const prepared = prepareBootstrapExecution(environment)
  expect(environment).toEqual(before)
  expect(prepared.timeoutSecs).toBe(605)
  expect(prepared.variables[BOOTSTRAP_BINARY_ENV]).toBe("cognia-bootstrap")
  expect(JSON.parse(prepared.variables[BOOTSTRAP_CONFIG_ENV])).toMatchObject({
    version: 1,
    setupCommand: "pnpm install",
    checks: agent.checks,
    secretEnv: ["COGNIA_BOOTSTRAP_API_KEY"],
    model: { apiKeyEnv: "COGNIA_BOOTSTRAP_API_KEY", requestTimeoutSecs: 60 },
    limits: { maxSteps: 32, totalTimeoutSecs: 600, commandTimeoutSecs: 60 },
  })
  expect(JSON.parse(prepared.variables[`${BOOTSTRAP_CONFIG_ENV}_MACOS`]).setupCommand).toBe(
    "brew install node"
  )
  expect(JSON.parse(prepared.variables[`${BOOTSTRAP_CONFIG_ENV}_LINUX`]).setupCommand).toBe(
    "npm ci"
  )
  expect(JSON.stringify(prepared)).not.toContain("provider:test")
  expect(prepared.script.byOs?.windows).toContain("exit /b 78")
})

it("keeps shell-looking task and command text in JSON, never the launcher", () => {
  const task = `$(touch /tmp/should-not-exist) 'literal' \"quoted\"`
  const binary = "/tmp/a 'quoted' $(literal)"
  const prepared = prepareBootstrapExecution({
    ...environment,
    bootstrapAgent: { ...agent, task, binary, checks: [{ name: "ready", command: task }] },
  })
  expect(JSON.parse(prepared.variables[BOOTSTRAP_CONFIG_ENV]).task).toBe(task)
  expect(prepared.variables[BOOTSTRAP_BINARY_ENV]).toBe(binary)
  expect(prepared.script.byOs?.macos).toContain(`exec '/tmp/a '\"'\"'quoted'\"'\"' $(literal)'`)
  expect(prepared.script.byOs?.macos).not.toContain("touch /tmp")
})

it("selects standalone Bash and PowerShell launchers without requiring a native binary", () => {
  const bash = prepareBootstrapExecution({
    ...environment,
    bootstrapAgent: { ...agent, runtime: "bash" },
  })
  expect(bash.variables[BOOTSTRAP_BINARY_ENV]).toBe("cognia-bootstrap.sh")
  expect(bash.script.byOs?.linux).toContain("exec bash 'cognia-bootstrap.sh' init")
  expect(bash.script.byOs?.windows).toContain("exit /b 78")
  const powershell = prepareBootstrapExecution({
    ...environment,
    bootstrapAgent: { ...agent, runtime: "powershell", binary: 'C:\\Agent tools\\a & "b".ps1' },
  })
  const command = powershell.script.byOs!.windows!
  expect(command).toMatch(
    /^pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
  )
  const decoded = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le")
  expect(decoded).toContain(
    "& $env:COGNIA_BOOTSTRAP_BINARY init --config-env COGNIA_BOOTSTRAP_CONFIG_WINDOWS"
  )
  expect(decoded).toContain("exit $LASTEXITCODE")
  expect(command).not.toContain("Agent tools")
  expect(powershell.variables[BOOTSTRAP_BINARY_ENV]).toBe('C:\\Agent tools\\a & "b".ps1')
  expect(powershell.script.byOs?.macos).toMatch(/^exec pwsh /)
  expect(JSON.parse(powershell.variables[BOOTSTRAP_CONFIG_ENV])).not.toHaveProperty("runtime")
})

it.each([
  { runtime: "unknown" },
  { task: "" },
  { baseUrl: "http://remote.example/v1" },
  { baseUrl: "https://user:secret@example.com/v1" },
  { baseUrl: "https://api.example.com/v1?token=x" },
  { model: "line\nmodel" },
  { apiKeyEnv: "BAD-NAME" },
  { binary: "bin\nname" },
  { checks: [] },
  {
    checks: [
      { name: "same", command: "true" },
      { name: "same", command: "true" },
    ],
  },
  { checks: [{ name: "bad name", command: "true" }] },
  { maxSteps: 0 },
  { maxSteps: 257 },
  { maxSteps: 1.5 },
  { totalTimeoutSecs: 3601 },
  { commandTimeoutSecs: 601 },
  { totalTimeoutSecs: 10, commandTimeoutSecs: 11 },
])("rejects invalid enabled configuration %p", (patch) => {
  expect(() =>
    assertBootstrapAgent({ ...agent, ...patch } as ProjectEnvironmentBootstrapAgent)
  ).toThrow()
})

it("accepts loopback HTTP and does not require a complete disabled draft", () => {
  expect(() =>
    assertBootstrapAgent({ ...agent, baseUrl: "http://localhost:11434/v1" })
  ).not.toThrow()
  expect(() =>
    assertBootstrapAgent({ ...agent, enabled: false, task: "", checks: [] })
  ).not.toThrow()
})

it("requires keyring credentials and refuses collisions with internal variables", () => {
  expect(() => assertBootstrapEnvironment({ ...environment, keyringReferences: [] })).toThrow(
    /keyring/
  )
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      variables: { COGNIA_BOOTSTRAP_API_KEY: "never-store" },
    })
  ).toThrow(/keyring/)
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      variables: { COGNIA_BOOTSTRAP_CONFIG_LINUX: "override" },
    })
  ).toThrow(/reservedVariable/)
})

it("omits empty deterministic setup and bounds the provider timeout to a shorter budget", () => {
  const prepared = prepareBootstrapExecution({
    ...environment,
    setupScript: { default: "" },
    bootstrapAgent: { ...agent, totalTimeoutSecs: 10, commandTimeoutSecs: 5 },
  })
  const config = JSON.parse(prepared.variables[BOOTSTRAP_CONFIG_ENV])
  expect(config).not.toHaveProperty("setupCommand")
  expect(config.model.requestTimeoutSecs).toBe(10)
  expect(prepared.timeoutSecs).toBe(15)
})

it("executes the Unix launcher without evaluating quoted paths or JSON shell syntax", () => {
  const root = mkdtempSync(join(tmpdir(), "cognia-bootstrap-launch-"))
  try {
    const sentinel = join(root, "must-not-exist")
    const binary = join(root, `bootstrap 'quote' \"double\" $(literal) %!`)
    writeFileSync(binary, "#!/bin/sh\nprintf '%s' \"$COGNIA_BOOTSTRAP_CONFIG\"\n", { mode: 0o700 })
    const task = `$(touch '${sentinel}')`
    const prepared = prepareBootstrapExecution({
      ...environment,
      bootstrapAgent: { ...agent, binary, task },
    })
    const output = execFileSync("sh", ["-c", prepared.script.byOs!.linux!], {
      cwd: root,
      env: { NODE_ENV: "test", PATH: process.env.PATH, ...prepared.variables },
      encoding: "utf8",
    })
    expect(JSON.parse(output)).toMatchObject({ task, setupCommand: "npm ci" })
    expect(existsSync(sentinel)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("bounds UTF-8 content and combined config before creating process variables", () => {
  expect(() => assertBootstrapAgent({ ...agent, task: "中".repeat(11000) })).toThrow(/task/)
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      bootstrapAgent: {
        ...agent,
        task: "x".repeat(30000),
        checks: [{ name: "ready", command: "x".repeat(30000) }],
      },
    })
  ).toThrow(/size/)
})

it("reserves the executable variable against plain, keyring and credential collisions", () => {
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      variables: { [BOOTSTRAP_BINARY_ENV]: "replacement" },
    })
  ).toThrow(/reservedVariable/)
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      keyringReferences: [
        ...environment.keyringReferences,
        { variable: BOOTSTRAP_BINARY_ENV, keyringRef: "provider:replacement" },
      ],
    })
  ).toThrow(/reservedVariable/)
  expect(() => assertBootstrapAgent({ ...agent, apiKeyEnv: BOOTSTRAP_BINARY_ENV })).toThrow(
    /credential/
  )
})

it("round-trips every advanced section without replacing the provider model or credential references", () => {
  const options = {
    modelOptions: {
      auth: "header" as const,
      apiKeyHeader: "X-API-Key",
      endpointPath: "custom/completions",
      requestTimeoutSecs: 120,
      maxTokens: 4096,
      temperature: 0.5,
      topP: 0.8,
      seed: 42,
      reasoningEffort: "high",
      thinking: { type: "enabled" },
      extraBody: { response_format: { type: "text" } },
      headers: { "X-Region": "local" },
      headersEnv: { "X-Tenant-Token": "TENANT_AUTH" },
      stream: true,
      showThinking: true,
    },
    context: {
      contextWindowTokens: 32768,
      compactThresholdTokens: 26000,
      compactRetainTokens: 6000,
      compactMaxTokens: 2048,
      compactRetries: 2,
      maxOverflowRetries: 2,
      autoCompact: true,
      pruneToolResults: true,
      pruneThresholdBytes: 2048,
      pruneHeadBytes: 1024,
      pruneTailBytes: 512,
    },
    tools: {
      profile: "dsh" as const,
      shell: true,
      editor: false,
      shellExecutable: "/bin/bash",
      shellArgs: ["--noprofile", "--norc"],
      environment: { LANG: "C.UTF-8" },
      maxFileBytes: 8388608,
    },
    reuse: { inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] },
    maxOutputBytes: 32768,
    maxContextBytes: 1048576,
    maxResponseBytes: 2097152,
  }
  expect(parseBootstrapAdvancedOptions(JSON.stringify(options))).toEqual(options)
  const prepared = prepareBootstrapExecution({
    ...environment,
    bootstrapAgent: { ...agent, ...options, systemPrompt: "Repair only this workspace." },
    keyringReferences: [
      ...environment.keyringReferences,
      { variable: "TENANT_AUTH", keyringRef: "tenant:test" },
    ],
  })
  const config = JSON.parse(prepared.variables[BOOTSTRAP_CONFIG_ENV])
  expect(config.model).toEqual({
    baseUrl: agent.baseUrl,
    model: agent.model,
    apiKeyEnv: "COGNIA_BOOTSTRAP_API_KEY",
    ...options.modelOptions,
  })
  expect(config).toMatchObject({
    context: options.context,
    tools: options.tools,
    reuse: options.reuse,
    systemPrompt: "Repair only this workspace.",
    limits: { maxOutputBytes: 32768, maxContextBytes: 1048576, maxResponseBytes: 2097152 },
    secretEnv: ["COGNIA_BOOTSTRAP_API_KEY", "TENANT_AUTH"],
  })
  expect(JSON.stringify(config)).not.toContain("tenant:test")
})

it("supports unauthenticated local models but still requires keyring references for credential headers", () => {
  const local = {
    ...environment,
    bootstrapAgent: {
      ...agent,
      baseUrl: "http://127.0.0.1:11434/v1",
      modelOptions: { auth: "none" as const },
    },
    keyringReferences: [],
  }
  expect(() => prepareBootstrapExecution(local)).not.toThrow()
  expect(() =>
    prepareBootstrapExecution({
      ...local,
      bootstrapAgent: {
        ...local.bootstrapAgent,
        apiKeyEnv: "LOCAL_AUTH",
        tools: { environment: { LOCAL_AUTH: "inline" } },
      },
    })
  ).toThrow(/tools/)
  expect(() =>
    prepareBootstrapExecution({
      ...local,
      bootstrapAgent: {
        ...local.bootstrapAgent,
        modelOptions: { auth: "none", headersEnv: { "X-Credential": "LOCAL_AUTH" } },
      },
    })
  ).toThrow(/keyring/)
})

it.each([
  { modelOptions: { unrecognized: true } },
  { modelOptions: { auth: "bad" } },
  { modelOptions: { auth: "header" } },
  { modelOptions: { headers: { Authorization: "literal" } } },
  { modelOptions: { headers: { "Content-Type": "text/plain" } } },
  { modelOptions: { headersEnv: { "X-Auth": "BAD-NAME" } } },
  { modelOptions: { headers: { "X-Org": "one", "x-org": "two" } } },
  { modelOptions: { extraBody: { messages: [] } } },
  { modelOptions: { temperature: 3 } },
  { modelOptions: { topP: -1 } },
  { modelOptions: { maxTokens: 0 } },
  { modelOptions: { stream: "true" } },
  { modelOptions: { thinking: "enabled" } },
  { modelOptions: { endpointPath: "../completions" } },
  { context: { compactThresholdTokens: 100, compactRetainTokens: 100 } },
  { context: { pruneThresholdBytes: 1024 } },
  { context: { compactRetries: 11 } },
  { tools: { environment: { BASH_ENV: "inject" } } },
  { tools: { environment: { API_TOKEN: "literal" } } },
  { tools: { environment: { NODE_OPTIONS: "--require=inject" } } },
  { tools: { environment: { LANG: "() { malicious" } } },
  { tools: { profile: "invalid" } },
  { tools: { shellArgs: [1] } },
  { tools: { maxFileBytes: 0 } },
  { tools: { maxFileBytes: 16777217 } },
  { reuse: { inputs: ["../outside"] } },
  { reuse: { outputs: ["node_modules", "node_modules"] } },
  { maxOutputBytes: 0 },
  { advancedOptionsDraft: "{" },
  { tools: null },
])("rejects unsafe or invalid advanced settings %p", (patch) => {
  expect(() =>
    assertBootstrapAgent({ ...agent, ...patch } as unknown as ProjectEnvironmentBootstrapAgent)
  ).toThrow()
})

it("does not silently discard advanced JSON keys or credential overrides", () => {
  expect(() => parseBootstrapAdvancedOptions('{"model":"ignored"}')).toThrow(/options/)
  expect(() => parseBootstrapAdvancedOptions("null")).toThrow(/options/)
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      bootstrapAgent: {
        ...agent,
        tools: { environment: { COGNIA_BOOTSTRAP_API_KEY: "override" } },
      },
    })
  ).toThrow(/tools/)
  expect(() =>
    assertBootstrapEnvironment({
      ...environment,
      bootstrapAgent: { ...agent, tools: { environment: { CUSTOM_AUTH: "override" } } },
      keyringReferences: [
        ...environment.keyringReferences,
        { variable: "CUSTOM_AUTH", keyringRef: "x:test" },
      ],
    })
  ).toThrow(/tools/)
})

it("counts all advanced options and each OS-specific setup in the actual process-variable budget", () => {
  expect(() =>
    prepareBootstrapExecution({
      ...environment,
      setupScript: { default: "", byOs: { linux: "x".repeat(31000), macos: "x".repeat(31000) } },
    })
  ).toThrow(/size/)
  expect(() =>
    prepareBootstrapExecution({
      ...environment,
      bootstrapAgent: { ...agent, modelOptions: { extraBody: { long: "x".repeat(13000) } } },
    })
  ).toThrow(/size/)
})

it.each([
  "api_key",
  "apiKey",
  "AUTHORIZATION",
  "password",
  "access_token",
  "api_token",
  "token",
  "secret",
  "credentials",
  "cookie",
])("rejects credential key %s at any extraBody nesting depth", (key) => {
  for (const extraBody of [{ [key]: "plain" }, { provider: [{ nested: { [key]: "plain" } }] }]) {
    expect(() => assertBootstrapAgent({ ...agent, modelOptions: { extraBody } })).toThrow(/options/)
  }
})

it("uses the actual UTF-8 configuration bytes for the 48 KiB aggregate limit", () => {
  const quoted = { ...agent, task: '"'.repeat(4000) }
  const prepared = prepareBootstrapExecution({ ...environment, bootstrapAgent: quoted })
  const configs = Object.entries(prepared.variables)
    .filter(([name]) => name.startsWith(BOOTSTRAP_CONFIG_ENV))
    .map(([, value]) => value)
  expect(
    configs.reduce((total, config) => total + new TextEncoder().encode(config).byteLength, 0)
  ).toBeLessThanOrEqual(48 * 1024)
})

it.each(["extraBody", "thinking"] as const)(
  "rejects nested and JSON-encoded credentials in %s",
  (field) => {
    for (const value of [
      { provider: [{ authorization: "plain" }] },
      { provider: JSON.stringify({ apiKey: "plain" }) },
      { provider: JSON.stringify([JSON.stringify({ access_token: "plain" })]) },
    ]) {
      expect(() => assertBootstrapAgent({ ...agent, modelOptions: { [field]: value } })).toThrow(
        /options/
      )
    }
  }
)

it("bounds nested JSON string decoding and preserves ordinary provider strings", () => {
  let encoded = "ordinary provider text"
  for (let depth = 0; depth < 8; depth++) encoded = JSON.stringify(encoded)
  expect(() =>
    assertBootstrapAgent({
      ...agent,
      modelOptions: { thinking: { type: "enabled" }, extraBody: { provider: encoded } },
    })
  ).not.toThrow()
  encoded = JSON.stringify(encoded)
  expect(() =>
    assertBootstrapAgent({ ...agent, modelOptions: { extraBody: { provider: encoded } } })
  ).toThrow(/options/)
  const extraBody = {
    provider: "ordinary provider text",
    malformedJson: '{"apiKey":',
    safeJson: JSON.stringify({ type: "text" }),
  }
  const prepared = prepareBootstrapExecution({
    ...environment,
    bootstrapAgent: { ...agent, modelOptions: { extraBody } },
  })
  expect(JSON.parse(prepared.variables[BOOTSTRAP_CONFIG_ENV]).model.extraBody).toEqual(extraBody)
})
