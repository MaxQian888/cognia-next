import type {
  ProjectEnvironment,
  ProjectEnvironmentBootstrapAgent,
  ProjectEnvironmentOs,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

export const BOOTSTRAP_CONFIG_ENV = "COGNIA_BOOTSTRAP_CONFIG"
export const BOOTSTRAP_BINARY_ENV = "COGNIA_BOOTSTRAP_BINARY"
export const BOOTSTRAP_RUNTIME_BINARIES = {
  native: "cognia-bootstrap",
  bash: "cognia-bootstrap.sh",
  powershell: "cognia-bootstrap.ps1",
} as const
export const BOOTSTRAP_DEFAULTS = {
  binary: "cognia-bootstrap",
  apiKeyEnv: "COGNIA_BOOTSTRAP_API_KEY",
  maxSteps: 32,
  totalTimeoutSecs: 600,
  commandTimeoutSecs: 60,
} as const

export type BootstrapValidationCode =
  | "runtime"
  | "task"
  | "endpoint"
  | "model"
  | "binary"
  | "credential"
  | "checks"
  | "limits"
  | "keyring"
  | "reservedVariable"
  | "size"
  | "options"
  | "context"
  | "tools"
  | "reuse"

export class BootstrapAgentValidationError extends Error {
  constructor(public readonly code: BootstrapValidationCode) {
    super(`Invalid bootstrap Agent configuration: ${code}`)
    this.name = "BootstrapAgentValidationError"
  }
}

function invalid(code: BootstrapValidationCode): never {
  throw new BootstrapAgentValidationError(code)
}

function isReservedBootstrapVariable(name: string): boolean {
  return name.startsWith(BOOTSTRAP_CONFIG_ENV) || name === BOOTSTRAP_BINARY_ENV
}

function validText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    new TextEncoder().encode(value).byteLength <= max &&
    !value.includes("\0")
  )
}

const MODEL_KEYS = [
  "auth",
  "apiKeyHeader",
  "endpointPath",
  "requestTimeoutSecs",
  "maxTokens",
  "temperature",
  "topP",
  "seed",
  "reasoningEffort",
  "thinking",
  "extraBody",
  "headers",
  "headersEnv",
  "stream",
  "showThinking",
]
const CONTEXT_KEYS = [
  "contextWindowTokens",
  "autoCompact",
  "compactThresholdTokens",
  "compactRetainTokens",
  "compactMaxTokens",
  "compactRetries",
  "maxOverflowRetries",
  "pruneToolResults",
  "pruneThresholdBytes",
  "pruneHeadBytes",
  "pruneTailBytes",
]
const TOOLS_KEYS = [
  "shell",
  "editor",
  "profile",
  "shellExecutable",
  "shellArgs",
  "environment",
  "maxFileBytes",
]
export const BOOTSTRAP_ADVANCED_KEYS = [
  "modelOptions",
  "context",
  "tools",
  "reuse",
  "maxOutputBytes",
  "maxContextBytes",
  "maxResponseBytes",
] as const
const RESERVED_BODY = new Set([
  "model",
  "messages",
  "tools",
  "stream",
  "tool_choice",
  "max_tokens",
  "temperature",
  "top_p",
  "seed",
  "reasoning_effort",
  "thinking",
  "api_key",
  "apiKey",
  "authorization",
  "headers",
  "endpoint",
  "base_url",
])
const CREDENTIAL_BODY_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "password",
  "access_token",
  "api_token",
  "token",
  "secret",
  "credentials",
  "cookie",
])
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "content-type",
  "connection",
  "proxy-authorization",
])
const STARTUP_ENV = new Set([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "SSH_AUTH_SOCK",
  "CDPATH",
  "GLOBIGNORE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "LD_AUDIT",
  "DYLD_FRAMEWORK_PATH",
  "SSH_AGENT_PID",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "DATABASE_URL",
  "REDIS_URL",
])
const sensitiveName = (name: string) =>
  /authorization|cookie|key|token|secret|password|credential/i.test(name)
const validEnvName = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !isReservedBootstrapVariable(name)
const validHeaderName = (name: string) =>
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) && !RESERVED_HEADERS.has(name.toLowerCase())
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
function hasCredentialBodyKey(value: unknown, encodedDepth = 0): boolean {
  if (typeof value === "string") {
    let nested: unknown
    try {
      nested = JSON.parse(value)
    } catch {
      return false
    }
    return encodedDepth >= 8 || hasCredentialBodyKey(nested, encodedDepth + 1)
  }
  if (Array.isArray(value))
    return value.some((nested) => hasCredentialBodyKey(nested, encodedDepth))
  return (
    object(value) &&
    Object.entries(value).some(
      ([key, nested]) =>
        CREDENTIAL_BODY_KEYS.has(key.toLowerCase()) || hasCredentialBodyKey(nested, encodedDepth)
    )
  )
}
function keys(value: unknown, allowed: readonly string[], code: BootstrapValidationCode): void {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid(code)
}
function integer(value: unknown, min: number, max: number, code: BootstrapValidationCode) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    invalid(code)
}
function booleanOption(value: unknown, code: BootstrapValidationCode) {
  if (value !== undefined && typeof value !== "boolean") invalid(code)
}

/** Parse an entire advanced section rather than dropping unrecognized settings. */
export function parseBootstrapAdvancedOptions(
  text: string
): Partial<ProjectEnvironmentBootstrapAgent> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    invalid("options")
  }
  keys(value, BOOTSTRAP_ADVANCED_KEYS, "options")
  return value as Partial<ProjectEnvironmentBootstrapAgent>
}

function credentialVariables(value: ProjectEnvironmentBootstrapAgent) {
  return [
    ...new Set([
      ...Object.values(value.modelOptions?.headersEnv ?? {}),
      ...((value.modelOptions?.auth ?? "bearer") === "none"
        ? []
        : [value.apiKeyEnv ?? BOOTSTRAP_DEFAULTS.apiKeyEnv]),
    ]),
  ]
}

export function assertBootstrapAdvancedOptions(value: ProjectEnvironmentBootstrapAgent) {
  if (value.advancedOptionsDraft !== undefined) invalid("options")
  if (value.systemPrompt !== undefined && !validText(value.systemPrompt, 65536)) invalid("options")
  for (const field of ["modelOptions", "context", "tools", "reuse"] as const) {
    if (value[field] !== undefined && !object(value[field])) invalid("options")
  }
  const m = value.modelOptions ?? {}
  keys(m, MODEL_KEYS, "options")
  if (m.auth !== undefined && !["none", "bearer", "header"].includes(m.auth)) invalid("options")
  if (m.requestTimeoutSecs !== undefined) integer(m.requestTimeoutSecs, 1, 600, "limits")
  if (m.maxTokens !== undefined) integer(m.maxTokens, 1, 16777216, "options")
  if (m.seed !== undefined)
    integer(m.seed, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "options")
  for (const [number, max] of [
    [m.temperature, 2],
    [m.topP, 1],
  ]) {
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > max!)
    )
      invalid("options")
  }
  for (const field of [m.stream, m.showThinking]) booleanOption(field, "options")
  if (
    m.reasoningEffort !== undefined &&
    (!validText(m.reasoningEffort, 128) || /[\x00-\x1f\x7f]/.test(m.reasoningEffort))
  )
    invalid("options")
  if (m.thinking !== undefined && (!object(m.thinking) || hasCredentialBodyKey(m.thinking)))
    invalid("options")
  if (
    m.extraBody !== undefined &&
    (!object(m.extraBody) ||
      Object.keys(m.extraBody).length > 64 ||
      Object.keys(m.extraBody).some((name) => RESERVED_BODY.has(name)) ||
      hasCredentialBodyKey(m.extraBody) ||
      new TextEncoder().encode(JSON.stringify(m.extraBody)).byteLength > 65536)
  )
    invalid("options")
  if (m.endpointPath !== undefined) {
    const path = m.endpointPath.replace(/^\/+/, "")
    if (
      !validText(path, 2048) ||
      /[\x00-\x1f\x7f?#%\\]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      invalid("endpoint")
  }
  if (
    m.auth === "header" &&
    (typeof m.apiKeyHeader !== "string" || !validHeaderName(m.apiKeyHeader))
  )
    invalid("options")
  if (m.apiKeyHeader !== undefined && typeof m.apiKeyHeader !== "string") invalid("options")
  const headerNames = new Set<string>()
  for (const map of [m.headers, m.headersEnv]) {
    if (map !== undefined && !object(map)) invalid("options")
  }
  for (const [map, secret] of [
    [m.headers ?? {}, false],
    [m.headersEnv ?? {}, true],
  ] as const) {
    if (!object(map)) invalid("options")
    for (const [name, content] of Object.entries(map)) {
      const normalized = name.toLowerCase()
      if (
        !validHeaderName(name) ||
        headerNames.has(normalized) ||
        typeof content !== "string" ||
        (m.auth !== "none" &&
          normalized === (m.auth === "header" ? m.apiKeyHeader! : "authorization").toLowerCase())
      )
        invalid("options")
      headerNames.add(normalized)
      if (
        secret
          ? !validEnvName(content)
          : sensitiveName(name) ||
            new TextEncoder().encode(content).byteLength > 8192 ||
            /[\x00-\x08\x0a-\x1f\x7f]/.test(content)
      )
        invalid("options")
    }
  }
  if (headerNames.size > 64) invalid("options")
  const c = value.context ?? {}
  keys(c, CONTEXT_KEYS, "context")
  const window = c.contextWindowTokens ?? 1000000
  const threshold = c.compactThresholdTokens ?? Math.floor(window * 0.8)
  const retain = c.compactRetainTokens ?? Math.floor(window * 0.16)
  integer(window, 128, 16777216, "context")
  integer(threshold, 1, window, "context")
  integer(retain, 0, threshold - 1, "context")
  integer(c.compactMaxTokens ?? 8192, 1, 1048576, "context")
  integer(c.compactRetries ?? 1, 0, 10, "context")
  integer(c.maxOverflowRetries ?? 1, 0, 10, "context")
  integer(c.pruneThresholdBytes ?? 8192, 256, 8388608, "context")
  integer(c.pruneHeadBytes ?? 4096, 0, 8388608, "context")
  integer(c.pruneTailBytes ?? 1024, 0, 8388608, "context")
  if ((c.pruneHeadBytes ?? 4096) + (c.pruneTailBytes ?? 1024) >= (c.pruneThresholdBytes ?? 8192))
    invalid("context")
  booleanOption(c.autoCompact, "context")
  booleanOption(c.pruneToolResults, "context")
  const tools = value.tools ?? {}
  keys(tools, TOOLS_KEYS, "tools")
  booleanOption(tools.shell, "tools")
  booleanOption(tools.editor, "tools")
  if (tools.profile !== undefined && !["native", "dsh"].includes(tools.profile)) invalid("tools")
  if (
    tools.shellExecutable !== undefined &&
    (!validText(tools.shellExecutable, 4096) || /[\x00-\x1f\x7f]/.test(tools.shellExecutable))
  )
    invalid("tools")
  if (
    tools.shellArgs !== undefined &&
    (!Array.isArray(tools.shellArgs) ||
      tools.shellArgs.length > 32 ||
      tools.shellArgs.some(
        (arg) =>
          typeof arg !== "string" ||
          arg.includes("\0") ||
          new TextEncoder().encode(arg).byteLength > 4096
      ))
  )
    invalid("tools")
  integer(tools.maxFileBytes ?? 4194304, 1024, 16777216, "tools")
  const env = tools.environment ?? {}
  if (tools.environment !== undefined && !object(tools.environment)) invalid("tools")
  if (!object(env) || Object.keys(env).length > 128) invalid("tools")
  for (const [name, content] of Object.entries(env)) {
    if (
      !validEnvName(name) ||
      sensitiveName(name) ||
      STARTUP_ENV.has(name.toUpperCase()) ||
      name.toUpperCase().startsWith("BASH_FUNC_") ||
      credentialVariables(value).includes(name) ||
      name === (value.apiKeyEnv ?? BOOTSTRAP_DEFAULTS.apiKeyEnv) ||
      typeof content !== "string" ||
      content.includes("\0") ||
      content.trimStart().startsWith("() {") ||
      new TextEncoder().encode(content).byteLength > 8192
    )
      invalid("tools")
  }
  const reuse = value.reuse ?? {}
  keys(reuse, ["inputs", "outputs"], "reuse")
  for (const paths of [reuse.inputs, reuse.outputs]) {
    if (paths !== undefined && !Array.isArray(paths)) invalid("reuse")
  }
  for (const paths of [reuse.inputs ?? [], reuse.outputs ?? []]) {
    if (
      !Array.isArray(paths) ||
      paths.length > 128 ||
      new Set(paths).size !== paths.length ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          !path ||
          path.includes("\0") ||
          path.startsWith("/") ||
          path.split("/").some((part) => !part || part === "." || part === "..")
      )
    )
      invalid("reuse")
  }
}

/** Shared save/run boundary, including rows imported without form validation. */
export function assertBootstrapAgent(value: ProjectEnvironmentBootstrapAgent): void {
  if (!value || typeof value.enabled !== "boolean") invalid("task")
  if (!value.enabled) return
  if (value.runtime !== undefined && !["native", "bash", "powershell"].includes(value.runtime))
    invalid("runtime")
  assertBootstrapAdvancedOptions(value)
  if (!validText(value.task, 32000)) invalid("task")
  if (!validText(value.model, 256) || /[\x00-\x1f\x7f]/.test(value.model)) invalid("model")
  try {
    if (!validText(value.baseUrl, 4096)) invalid("endpoint")
    const url = new URL(value.baseUrl)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid("endpoint")
    if (
      url.protocol === "http:" &&
      !["localhost", "[::1]"].includes(url.hostname) &&
      !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    )
      invalid("endpoint")
  } catch {
    invalid("endpoint")
  }
  // Executable paths are shell-quoted below, so metacharacters stay literal.
  const binary = value.binary ?? BOOTSTRAP_RUNTIME_BINARIES[value.runtime ?? "native"]
  if (!validText(binary, 4096) || /[\x00-\x1f\x7f]/.test(binary)) invalid("binary")
  const apiKeyEnv = value.apiKeyEnv ?? BOOTSTRAP_DEFAULTS.apiKeyEnv
  if (
    !validText(apiKeyEnv, 128) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiKeyEnv) ||
    isReservedBootstrapVariable(apiKeyEnv)
  )
    invalid("credential")
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 32)
    invalid("checks")
  const names = new Set<string>()
  for (const check of value.checks) {
    if (
      !check ||
      !validText(check.name, 64) ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(check.name) ||
      names.has(check.name) ||
      !validText(check.command, 32000)
    )
      invalid("checks")
    names.add(check.name)
  }
  const limits = bootstrapLimits(value)
  for (const [number, max] of [
    [limits.maxSteps, 256],
    [limits.totalTimeoutSecs, 3600],
    [limits.commandTimeoutSecs, 600],
  ]) {
    if (!Number.isInteger(number) || number < 1 || number > max) invalid("limits")
  }
  if (limits.commandTimeoutSecs > limits.totalTimeoutSecs) invalid("limits")
  integer(limits.maxOutputBytes, 256, 1048576, "limits")
  integer(limits.maxContextBytes, 4096, 8388608, "limits")
  integer(limits.maxResponseBytes, 1024, 8388608, "limits")
}

export function assertBootstrapEnvironment(
  environment: Pick<
    ProjectEnvironment,
    "bootstrapAgent" | "variables" | "keyringReferences" | "setupScript"
  >
): void {
  const agent = environment.bootstrapAgent
  if (!agent) return
  assertBootstrapAgent(agent)
  if (!agent.enabled) return
  // Config is passed through process variables on every supported host.
  // Keep all OS variants comfortably below macOS ARG_MAX and Linux's per-
  // variable limit, including UTF-8 text and JSON escaping overhead.
  const configs = [undefined, "macos", "linux", "windows"].map((os) =>
    bootstrapConfig(environment, agent, os as ProjectEnvironmentOs | undefined)
  )
  const configBytes = configs.reduce(
    (total, config) => total + new TextEncoder().encode(JSON.stringify(config)).byteLength,
    0
  )
  if (configBytes > 48 * 1024) invalid("size")
  for (const key of credentialVariables(agent)) {
    if (
      key in environment.variables ||
      !environment.keyringReferences.some(
        (reference) => reference.variable === key && reference.keyringRef.trim()
      )
    )
      invalid("keyring")
  }
  if (
    Object.keys(agent.tools?.environment ?? {}).some((name) =>
      environment.keyringReferences.some((reference) => reference.variable === name)
    )
  )
    invalid("tools")
  if (
    Object.keys(environment.variables).some(isReservedBootstrapVariable) ||
    environment.keyringReferences.some((reference) =>
      isReservedBootstrapVariable(reference.variable)
    )
  )
    invalid("reservedVariable")
}

function bootstrapLimits(value: ProjectEnvironmentBootstrapAgent) {
  return {
    maxSteps: value.maxSteps ?? BOOTSTRAP_DEFAULTS.maxSteps,
    totalTimeoutSecs: value.totalTimeoutSecs ?? BOOTSTRAP_DEFAULTS.totalTimeoutSecs,
    commandTimeoutSecs: value.commandTimeoutSecs ?? BOOTSTRAP_DEFAULTS.commandTimeoutSecs,
    maxOutputBytes: value.maxOutputBytes ?? 16000,
    maxContextBytes: value.maxContextBytes ?? 128000,
    maxResponseBytes: value.maxResponseBytes ?? 1048576,
  }
}

function bootstrapConfig(
  environment: Pick<ProjectEnvironment, "setupScript" | "keyringReferences">,
  agent: ProjectEnvironmentBootstrapAgent,
  os?: ProjectEnvironmentOs
) {
  const limits = bootstrapLimits(agent)
  const setupCommand =
    (os ? environment.setupScript.byOs?.[os]?.trim() : "") || environment.setupScript.default.trim()
  return {
    version: 1,
    task: agent.task,
    model: {
      baseUrl: agent.baseUrl,
      model: agent.model,
      apiKeyEnv: agent.apiKeyEnv ?? BOOTSTRAP_DEFAULTS.apiKeyEnv,
      requestTimeoutSecs: Math.min(60, limits.totalTimeoutSecs),
      ...agent.modelOptions,
    },
    ...(agent.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
    ...(agent.context !== undefined ? { context: agent.context } : {}),
    ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
    ...(agent.reuse !== undefined ? { reuse: agent.reuse } : {}),
    ...(setupCommand ? { setupCommand } : {}),
    checks: agent.checks,
    secretEnv: [...new Set(environment.keyringReferences.map(({ variable }) => variable))].sort(),
    limits,
  }
}

function quoteSh(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

/**
 * Prepare every OS variant before transport. Only the execution host selects
 * an OS; secrets stay in keyring references, JSON stays in process variables.
 * Existing scripts remain untouched, including deterministic OS overrides.
 */
export function prepareBootstrapExecution(
  environment: ProjectEnvironment,
  force = false
): {
  script: ProjectEnvironmentScript
  variables: Record<string, string>
  timeoutSecs: number
} {
  assertBootstrapEnvironment(environment)
  const agent = environment.bootstrapAgent
  if (!agent?.enabled) throw new BootstrapAgentValidationError("task")
  const limits = bootstrapLimits(agent)
  const runtime = agent.runtime ?? "native"
  const binary = agent.binary ?? BOOTSTRAP_RUNTIME_BINARIES[runtime]
  const config = (os?: ProjectEnvironmentOs) =>
    JSON.stringify(bootstrapConfig(environment, agent, os))
  const forceArg = force ? " --force" : ""
  const executable = runtime === "bash" ? `bash ${quoteSh(binary)}` : quoteSh(binary)
  const powershell = (name: string, unix: boolean) => {
    // Fixed ASCII source only: the user-selected path stays in an environment
    // variable, so neither cmd.exe nor PowerShell reparses it as source code.
    const source = `$ErrorActionPreference = 'Stop'; & $env:${BOOTSTRAP_BINARY_ENV} init --config-env ${name}${forceArg}; exit $LASTEXITCODE`
    const encoded = btoa(Array.from(source, (char) => char + "\0").join(""))
    return `${unix ? "exec " : ""}pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
  }
  const unix = (name: string) =>
    runtime === "powershell"
      ? powershell(name, true)
      : `export ${BOOTSTRAP_CONFIG_ENV}="$${name}"; exec ${executable} init --config-env ${BOOTSTRAP_CONFIG_ENV}${forceArg}`
  const variables: Record<string, string> = {
    ...environment.variables,
    [BOOTSTRAP_CONFIG_ENV]: config(),
    [BOOTSTRAP_BINARY_ENV]: binary,
  }
  for (const os of ["macos", "linux", "windows"] as const) {
    variables[`${BOOTSTRAP_CONFIG_ENV}_${os.toUpperCase()}`] = config(os)
  }
  return {
    script: {
      default:
        runtime === "powershell"
          ? powershell(BOOTSTRAP_CONFIG_ENV, true)
          : `exec ${executable} init --config-env ${BOOTSTRAP_CONFIG_ENV}${forceArg}`,
      byOs: {
        macos: unix(`${BOOTSTRAP_CONFIG_ENV}_MACOS`),
        linux: unix(`${BOOTSTRAP_CONFIG_ENV}_LINUX`),
        windows:
          runtime === "powershell"
            ? powershell(`${BOOTSTRAP_CONFIG_ENV}_WINDOWS`, false)
            : "echo Select the standalone PowerShell runtime for a Windows host 1>&2 & exit /b 78",
      },
    },
    variables,
    // Allow the bounded CLI to report and release child processes itself.
    timeoutSecs: limits.totalTimeoutSecs + 5,
  }
}
