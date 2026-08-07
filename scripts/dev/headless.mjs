#!/usr/bin/env node

import { constants as fsConstants, rmSync } from "node:fs"
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Argument, Command, CommanderError } from "commander"
import { execa } from "execa"
import { z } from "zod"

const EXIT_USAGE = 2
const EXIT_PREFLIGHT = 3
const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), "../..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""

class UsageError extends Error {}
class PreflightError extends Error {}

const cliOptionsSchema = z
  .object({
    action: z.enum(["serve", "token"]).default("serve"),
    allowRemoteTerminal: z.boolean().default(false),
    advertiseUrl: z.url("--advertise-url must be a valid URL").optional(),
    check: z.boolean().default(false),
    dataDir: z.string().min(1, "--data-dir must not be empty").optional(),
    dryRun: z.boolean().default(false),
    gateway: z.boolean().default(false),
    localDebug: z.boolean().default(false),
    port: z.coerce
      .number({ error: "--port must be an integer between 1 and 65535" })
      .int("--port must be an integer between 1 and 65535")
      .min(1, "--port must be an integer between 1 and 65535")
      .max(65_535, "--port must be an integer between 1 and 65535"),
    skipBuild: z.boolean().default(false),
  })
  .refine(({ check, dryRun }) => !(check && dryRun), {
    message: "--check and --dry-run cannot be combined",
  })
  .refine(
    ({ action, advertiseUrl, allowRemoteTerminal, check, dryRun, gateway, localDebug }) =>
      action === "serve" ||
      (!advertiseUrl && !allowRemoteTerminal && !check && !dryRun && !gateway && !localDebug),
    { message: "token only accepts --data-dir" }
  )
  .refine(
    ({ advertiseUrl, allowRemoteTerminal, localDebug }) =>
      !localDebug || (!advertiseUrl && !allowRemoteTerminal),
    { message: "--local-debug cannot be combined with --advertise-url or --allow-remote-terminal" }
  )

function createProgram() {
  return new Command()
    .name("pnpm dev:headless")
    .description(
      "Starts the Cognia server, Brain, and agent sidecars. It does not start Next.js or a Tauri WebView."
    )
    .addArgument(
      new Argument("[action]", "serve, or print a loopback-only debug service token")
        .choices(["serve", "token"])
        .default("serve")
    )
    .configureHelp({ helpWidth: 120 })
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("-p, --port <port>", "Companion HTTPS port.", "27890")
    .option("--data-dir <path>", "Persistent development data directory.")
    .option("--advertise-url <url>", "Public URL written into pairing payloads.")
    .option("--gateway", "Enable the local LLM gateway.")
    .option(
      "--local-debug",
      "Bind to loopback and create a temporary Apifox/Postman environment with automatic authentication."
    )
    .option("--allow-remote-terminal", "Enable remote terminal tickets for granted devices.")
    .option("--skip-build", "Reuse existing headless build artifacts.")
    .option("--check", "Validate prerequisites and artifacts, then exit.")
    .option("--dry-run", "Print the redacted build and launch plan without writes.")
    .addHelpText(
      "after",
      "\nExamples:\n  pnpm dev:headless\n  pnpm dev:headless --local-debug --skip-build\n  pnpm dev:headless --skip-build\n  pnpm --silent dev:headless token\n"
    )
}

function parseCli(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    if (error instanceof CommanderError) throw new UsageError(error.message)
    throw error
  }
  const result = cliOptionsSchema.safeParse({ ...program.opts(), action: program.args[0] })
  if (!result.success) throw new UsageError(result.error.issues[0].message)
  return result.data
}

function pathsFor(options, env) {
  const dataDir = path.resolve(
    options.dataDir ||
      env.COGNIA_DATA_DIR ||
      path.join(repoRoot, ".cache", options.localDebug ? "headless-local-debug" : "headless")
  )
  return {
    dataDir,
    server: path.resolve(
      env.COGNIA_HEADLESS_SERVER_BIN ||
        path.join(repoRoot, "target", "debug", `cognia-server${executableSuffix}`)
    ),
    brain: path.resolve(
      env.COGNIA_BRAIN_ENTRY || path.join(repoRoot, "cli", "dist", "cognia-agent.mjs")
    ),
    sidecar: path.resolve(
      env.COGNIA_SIDECAR_SCRIPT || path.join(repoRoot, "sidecar", "claude-host.mjs")
    ),
    mcpSidecar: path.resolve(
      env.COGNIA_MCP_SIDECAR_PATH || path.join(repoRoot, "sidecar", "cognia-mcp.mjs")
    ),
    vscodeHost: path.resolve(
      env.COGNIA_VSCODE_EXT_HOST_SCRIPT ||
        path.join(repoRoot, "sidecar", "vscode-ext-host", "dist", "host.js")
    ),
    codeServerVsix: path.resolve(
      env.COGNIA_CODE_SERVER_AGENT_VSIX ||
        path.join(repoRoot, "sidecar", "codeserver-agent-ext", "cognia-agent-bridge.vsix")
    ),
  }
}

function secretConfig(dataDir, env) {
  const inline = (env.COGNIA_MASTER_KEY || "").trim()
  if (inline) {
    if (!/^[a-fA-F0-9]{64}$/.test(inline)) {
      throw new UsageError("COGNIA_MASTER_KEY must be exactly 64 hexadecimal characters")
    }
    return { kind: "inline", value: inline }
  }
  return {
    kind: "file",
    path: path.resolve(env.COGNIA_MASTER_KEY_FILE || path.join(dataDir, "master.key")),
  }
}

function buildSteps(pnpmBin) {
  return [
    { command: pnpmBin, args: ["cli:external-host:build"] },
    { command: pnpmBin, args: ["exec", "node", "scripts/build/build-cli.mjs"] },
    { command: pnpmBin, args: ["exec", "node", "scripts/build/build-mcp-sidecar.mjs"] },
    {
      command: pnpmBin,
      args: ["exec", "node", "scripts/build/build-vscode-ext-host-sidecar.mjs"],
    },
    { command: pnpmBin, args: ["sidecar:codeserver-agent:build"] },
    { command: pnpmBin, args: ["terminal-host:prepare:dev"] },
  ]
}

function launchArgs(options) {
  const args = ["serve", "--port", String(options.port)]
  if (options.localDebug) args.push("--bind-loopback")
  if (options.advertiseUrl) args.push("--advertise-url", options.advertiseUrl)
  if (options.allowRemoteTerminal) args.push("--allow-remote-terminal")
  return args
}

function launchEnvironment(options, paths, secret, env, localDebug) {
  const childEnv = {
    ...env,
    COGNIA_BRAIN_ENTRY: paths.brain,
    COGNIA_CODE_SERVER_AGENT_VSIX: paths.codeServerVsix,
    COGNIA_DATA_DIR: paths.dataDir,
    COGNIA_EXEC_BACKEND: env.COGNIA_EXEC_BACKEND || "local-process",
    COGNIA_MCP_SIDECAR_PATH: paths.mcpSidecar,
    COGNIA_PLUGIN_NODE_PATH: env.COGNIA_PLUGIN_NODE_PATH || process.execPath,
    COGNIA_PUBLIC_URL: options.localDebug
      ? `https://127.0.0.1:${options.port}`
      : options.advertiseUrl || env.COGNIA_PUBLIC_URL || `https://127.0.0.1:${options.port}`,
    COGNIA_SIDECAR_SCRIPT: paths.sidecar,
    COGNIA_VSCODE_EXT_HOST_SCRIPT: paths.vscodeHost,
  }
  if (options.gateway) childEnv.COGNIA_GATEWAY = "1"
  if (localDebug) {
    childEnv.COGNIA_APIFOX_ENV_PATH = localDebug.environmentPath
    childEnv.COGNIA_LOCAL_DEBUG_TOKEN = localDebug.token
  }
  if (secret.kind === "inline") {
    childEnv.COGNIA_MASTER_KEY = secret.value
    delete childEnv.COGNIA_MASTER_KEY_FILE
  } else {
    childEnv.COGNIA_MASTER_KEY_FILE = secret.path
    delete childEnv.COGNIA_MASTER_KEY
  }
  return childEnv
}

function redactedEnvironment(childEnv) {
  const selected = {}
  for (const key of [
    "COGNIA_BRAIN_ENTRY",
    "COGNIA_APIFOX_ENV_PATH",
    "COGNIA_CODE_SERVER_AGENT_VSIX",
    "COGNIA_DATA_DIR",
    "COGNIA_EXEC_BACKEND",
    "COGNIA_GATEWAY",
    "COGNIA_MASTER_KEY",
    "COGNIA_MASTER_KEY_FILE",
    "COGNIA_LOCAL_DEBUG_TOKEN",
    "COGNIA_MCP_SIDECAR_PATH",
    "COGNIA_PLUGIN_NODE_PATH",
    "COGNIA_PUBLIC_URL",
    "COGNIA_SIDECAR_SCRIPT",
    "COGNIA_VSCODE_EXT_HOST_SCRIPT",
  ]) {
    if (childEnv[key] !== undefined) {
      selected[key] =
        key === "COGNIA_MASTER_KEY" || key === "COGNIA_LOCAL_DEBUG_TOKEN"
          ? "<redacted>"
          : childEnv[key]
    }
  }
  return selected
}

function planFor(options, paths, secret, env) {
  const localDebug = options.localDebug
    ? {
        environmentPath: localDebugEnvironmentPath(paths.dataDir),
        token: "<ephemeral-at-launch>",
      }
    : undefined
  const childEnv = launchEnvironment(options, paths, secret, env, localDebug)
  return {
    mode: "dry-run",
    dataDir: paths.dataDir,
    port: options.port,
    gateway: options.gateway,
    build: options.skipBuild ? [] : buildSteps(env.COGNIA_HEADLESS_PNPM_BIN || "pnpm"),
    launch: {
      command: paths.server,
      args: launchArgs(options),
      environment: redactedEnvironment(childEnv),
    },
  }
}

function localDebugEnvironmentPath(dataDir) {
  return path.join(dataDir, "apifox", "cognia-local-debug.postman_environment.json")
}

function createLocalDebugConfig(paths) {
  return {
    environmentPath: localDebugEnvironmentPath(paths.dataDir),
    token: randomBytes(32).toString("base64url"),
  }
}

async function writeLocalDebugEnvironment(options, paths, localDebug) {
  const directory = path.dirname(localDebug.environmentPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") await chmod(directory, 0o700)
  const values = [
    {
      key: "baseUrl",
      value: `https://127.0.0.1:${options.port}`,
      enabled: true,
      type: "default",
    },
    {
      key: "serviceToken",
      value: localDebug.token,
      enabled: true,
      type: "secret",
    },
    {
      key: "caCertPath",
      value: path.join(paths.dataDir, "cognia", "companion", "tls.pem"),
      enabled: true,
      type: "default",
    },
  ]
  await writeFile(
    localDebug.environmentPath,
    `${JSON.stringify(
      {
        id: randomBytes(16).toString("hex"),
        name: "Cognia Headless Local Debug",
        values,
        _postman_variable_scope: "environment",
        _postman_exported_at: new Date().toISOString(),
        _postman_exported_using: "cognia-next dev:headless --local-debug",
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  if (process.platform !== "win32") await chmod(localDebug.environmentPath, 0o600)
}

function installLocalDebugExitCleanup(environmentPath) {
  const cleanup = () => {
    try {
      rmSync(environmentPath, { force: true })
    } catch {
      // Exit cleanup is best-effort; the credential is invalid once the
      // server process is gone even if the filesystem is already unavailable.
    }
  }
  const signalHandlers = new Map([
    [
      "SIGINT",
      () => {
        cleanup()
        process.exit(130)
      },
    ],
    [
      "SIGTERM",
      () => {
        cleanup()
        process.exit(143)
      },
    ],
  ])
  process.once("exit", cleanup)
  for (const [signal, handler] of signalHandlers) process.once(signal, handler)
  return () => {
    process.removeListener("exit", cleanup)
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }
}

async function validateSecret(secret) {
  if (secret.kind === "inline") return
  let value
  try {
    value = (await readFile(secret.path, "utf8")).trim()
  } catch (error) {
    throw new PreflightError(`master key file is not readable at ${secret.path}: ${error.message}`)
  }
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new PreflightError(
      `master key file must contain exactly 64 hexadecimal characters: ${secret.path}`
    )
  }
}

async function validateArtifacts(paths) {
  const required = [
    ["cognia-server", paths.server, fsConstants.X_OK],
    ["Brain", paths.brain, fsConstants.R_OK],
    ["agent sidecar", paths.sidecar, fsConstants.R_OK],
    ["MCP sidecar", paths.mcpSidecar, fsConstants.R_OK],
    ["VS Code extension host", paths.vscodeHost, fsConstants.R_OK],
    ["code-server agent extension", paths.codeServerVsix, fsConstants.R_OK],
  ]
  for (const [label, target, mode] of required) {
    try {
      await access(target, mode)
    } catch {
      throw new PreflightError(`${label} artifact is missing or inaccessible: ${target}`)
    }
  }
}

async function validateServerArtifact(paths) {
  try {
    await access(paths.server, fsConstants.X_OK)
  } catch {
    throw new PreflightError(
      `cognia-server artifact is missing or inaccessible: ${paths.server}; run pnpm dev:headless once to build it`
    )
  }
}

async function prepareSecret(secret, dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (secret.kind === "inline") return
  await mkdir(path.dirname(secret.path), { recursive: true, mode: 0o700 })
  let created = false
  try {
    await writeFile(secret.path, `${randomBytes(32).toString("hex")}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    created = true
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw new PreflightError(`cannot create master key file at ${secret.path}: ${error.message}`)
    }
  }
  if (process.platform !== "win32") await chmod(secret.path, 0o600)
  await validateSecret(secret)
  if (created) process.stderr.write(`Created persistent development master key: ${secret.path}\n`)
}

function tokenEnvironment(paths, secret, env) {
  const childEnv = { ...env, COGNIA_DATA_DIR: paths.dataDir }
  if (secret.kind === "inline") {
    childEnv.COGNIA_MASTER_KEY = secret.value
    delete childEnv.COGNIA_MASTER_KEY_FILE
  } else {
    childEnv.COGNIA_MASTER_KEY_FILE = secret.path
    delete childEnv.COGNIA_MASTER_KEY
  }
  return childEnv
}

async function runProcess(command, args, label, env) {
  let result
  try {
    result = await execa(command, args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      reject: false,
    })
  } catch (error) {
    throw new PreflightError(`${label} could not start: ${error.message}`)
  }
  if (result.exitCode !== 0 || result.signal) {
    const status = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`
    throw new PreflightError(`${label} failed with ${status}`)
  }
  return result
}

async function buildHeadlessArtifacts(env) {
  const steps = buildSteps(env.COGNIA_HEADLESS_PNPM_BIN || "pnpm")
  for (const [index, step] of steps.entries()) {
    process.stdout.write(`Building headless artifacts (${index + 1}/${steps.length})...\n`)
    const buildEnv = { ...env }
    delete buildEnv.COGNIA_MASTER_KEY
    await runProcess(step.command, step.args, `headless build step ${index + 1}`, buildEnv)
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (!options) return
  const paths = pathsFor(options, process.env)
  const secret = secretConfig(paths.dataDir, process.env)
  if (options.action === "token") {
    await prepareSecret(secret, paths.dataDir)
    await validateServerArtifact(paths)
    await runProcess(
      paths.server,
      ["issue-service-token"],
      "cognia-server token issuer",
      tokenEnvironment(paths, secret, process.env)
    )
    return
  }
  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(planFor(options, paths, secret, process.env), null, 2)}\n`
    )
    return
  }
  if (options.check) {
    await validateSecret(secret)
    await validateArtifacts(paths)
    process.stdout.write(
      `Headless development artifacts are ready.\n` +
        `Next.js and Tauri WebView: not started.\n` +
        `Companion URL: https://127.0.0.1:${options.port}\n`
    )
    return
  }
  if (!options.skipBuild) {
    await buildHeadlessArtifacts(process.env)
  }
  await prepareSecret(secret, paths.dataDir)
  await validateArtifacts(paths)
  const localDebug = options.localDebug ? createLocalDebugConfig(paths) : undefined
  if (localDebug) await writeLocalDebugEnvironment(options, paths, localDebug)
  const removeExitCleanup = localDebug
    ? installLocalDebugExitCleanup(localDebug.environmentPath)
    : undefined
  const childEnv = launchEnvironment(options, paths, secret, process.env, localDebug)
  process.stdout.write(
    `Starting renderer-free Cognia at https://127.0.0.1:${options.port}\n` +
      `Next.js and Tauri WebView: not started.\n` +
      (localDebug
        ? `Local debug authentication: ephemeral token enabled.\n` +
          `Apifox environment: ${localDebug.environmentPath}\n` +
          `The token expires when this server process stops.\n`
        : "")
  )
  try {
    await runProcess(paths.server, launchArgs(options), "cognia-server", childEnv)
  } finally {
    if (localDebug) await rm(localDebug.environmentPath, { force: true })
    removeExitCleanup?.()
  }
}

main().catch((error) => {
  const usage = error instanceof UsageError
  const prefix = usage ? "Usage error" : "Preflight error"
  process.stderr.write(`${prefix}: ${error.message}\n`)
  process.exitCode = usage ? EXIT_USAGE : EXIT_PREFLIGHT
})
