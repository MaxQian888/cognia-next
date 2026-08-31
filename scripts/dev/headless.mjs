#!/usr/bin/env node

import { constants as fsConstants, rmSync } from "node:fs"
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { createDecipheriv, randomBytes } from "node:crypto"
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
const DEFAULT_DEVELOPMENT_WEB_ORIGINS = "http://localhost:3000,http://127.0.0.1:3000"

class UsageError extends Error {}
class PreflightError extends Error {}

const cliOptionsSchema = z
  .object({
    action: z.enum(["serve", "pair", "token", "browser-enroll"]).default("serve"),
    allowRemoteTerminal: z.boolean().default(false),
    advertiseUrl: z.url("--advertise-url must be a valid URL").optional(),
    browserListenerPort: z.coerce
      .number({ error: "--browser-listener-port must be an integer between 1 and 65535" })
      .int("--browser-listener-port must be an integer between 1 and 65535")
      .min(1, "--browser-listener-port must be an integer between 1 and 65535")
      .max(65_535, "--browser-listener-port must be an integer between 1 and 65535")
      .optional(),
    check: z.boolean().default(false),
    dataDir: z.string().min(1, "--data-dir must not be empty").optional(),
    deviceName: z.string().trim().min(1, "--device-name must not be empty").optional(),
    dryRun: z.boolean().default(false),
    gateway: z.boolean().default(false),
    localDebug: z.boolean().default(false),
    port: z.coerce
      .number({ error: "--port must be an integer between 1 and 65535" })
      .int("--port must be an integer between 1 and 65535")
      .min(1, "--port must be an integer between 1 and 65535")
      .max(65_535, "--port must be an integer between 1 and 65535"),
    skipBuild: z.boolean().default(false),
    recoverSecretStore: z.boolean().default(false),
    tenantId: z.string().trim().min(1, "--tenant-id must not be empty").optional(),
    workspacesDir: z.string().trim().min(1, "--workspaces-dir must not be empty").optional(),
  })
  .refine(({ check, dryRun }) => !(check && dryRun), {
    message: "--check and --dry-run cannot be combined",
  })
  .refine(
    ({
      action,
      advertiseUrl,
      allowRemoteTerminal,
      browserListenerPort,
      check,
      deviceName,
      dryRun,
      gateway,
      localDebug,
      tenantId,
      workspacesDir,
    }) =>
      action !== "token" ||
      (!workspacesDir &&
        !advertiseUrl &&
        !allowRemoteTerminal &&
        !browserListenerPort &&
        !check &&
        !deviceName &&
        !dryRun &&
        !gateway &&
        !localDebug &&
        !tenantId),
    { message: "token only accepts --data-dir" }
  )
  .refine(
    ({
      action,
      allowRemoteTerminal,
      browserListenerPort,
      check,
      dryRun,
      gateway,
      localDebug,
      recoverSecretStore,
      workspacesDir,
    }) =>
      action !== "pair" ||
      (!workspacesDir &&
        !allowRemoteTerminal &&
        !browserListenerPort &&
        !check &&
        !dryRun &&
        !gateway &&
        !localDebug &&
        !recoverSecretStore),
    {
      message:
        "pair accepts --data-dir, --device-name, --advertise-url, --port, --tenant-id, and --skip-build",
    }
  )
  // `--device-name` is absent on purpose: a browser device names itself at
  // registration time (the extension sends `displayName` with its own key), so
  // a label passed here would be silently dropped.
  .refine(
    ({
      action,
      advertiseUrl,
      allowRemoteTerminal,
      check,
      deviceName,
      dryRun,
      gateway,
      localDebug,
      recoverSecretStore,
      workspacesDir,
    }) =>
      action !== "browser-enroll" ||
      (!workspacesDir &&
        !advertiseUrl &&
        !allowRemoteTerminal &&
        !check &&
        !deviceName &&
        !dryRun &&
        !gateway &&
        !localDebug &&
        !recoverSecretStore),
    {
      message:
        "browser-enroll accepts --data-dir, --browser-listener-port, --tenant-id, and --skip-build",
    }
  )
  .refine(
    ({ action, check, dryRun, recoverSecretStore }) =>
      !recoverSecretStore || (action === "serve" && !check && !dryRun),
    { message: "--recover-secret-store is only valid when starting the server" }
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
      new Argument(
        "[action]",
        "serve, issue a cgnp3 pairing invitation for the app's pair screen, mint a cgnb1 enrollment for the browser extension, or print a loopback-only debug service token"
      )
        .choices(["serve", "pair", "token", "browser-enroll"])
        .default("serve")
    )
    .configureHelp({ helpWidth: 120 })
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("-p, --port <port>", "Companion HTTPS port.", "27890")
    .option("--data-dir <path>", "Persistent development data directory.")
    .option("--advertise-url <url>", "Public URL written into pairing payloads.")
    .option(
      "--device-name <name>",
      "Human-readable label for a cgnp3 pairing invitation (pair only)."
    )
    .option("--tenant-id <id>", "Tenant encoded into a pairing invitation or a browser enrollment.")
    .option("--gateway", "Enable the local LLM gateway.")
    .option(
      "--local-debug",
      "Bind to loopback and create a temporary Apifox/Postman environment with automatic authentication."
    )
    .option("--allow-remote-terminal", "Enable remote terminal tickets for granted devices.")
    .option(
      "--browser-listener-port <port>",
      "serve: also bind the plaintext loopback listener a browser tab can reach without a certificate (27891 by default in dev:web-headless); off unless passed. browser-enroll: the already-bound listener the enrollment advertises (27891 when omitted)."
    )
    .option(
      "--workspaces-dir <path>",
      "serve: the only directory tree remote clients may browse and run in (COGNIA_WORKSPACES_DIR). Defaults to <data dir>/workspaces. Read once at startup."
    )
    .option("--skip-build", "Reuse existing headless build artifacts.")
    .option(
      "--recover-secret-store",
      "Preserve an unreadable encrypted development store and start with an empty store."
    )
    .option("--check", "Validate prerequisites and artifacts, then exit.")
    .option("--dry-run", "Print the redacted build and launch plan without writes.")
    .addHelpText(
      "after",
      "\nExamples:\n  pnpm dev:headless\n  pnpm dev:headless --local-debug --skip-build\n  pnpm dev:headless --skip-build\n  pnpm --silent dev:headless pair --device-name browser\n  pnpm --silent dev:headless browser-enroll --skip-build\n  pnpm --silent dev:headless token\n"
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
  const cargoTargetDir = path.resolve(env.CARGO_TARGET_DIR || path.join(repoRoot, "target"))
  return {
    dataDir,
    server: path.resolve(
      env.COGNIA_HEADLESS_SERVER_BIN ||
        path.join(cargoTargetDir, "debug", `cognia-server${executableSuffix}`)
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
        path.join(repoRoot, "sidecar", "codeserver-agent-ext", "cognia-managed-broker.vsix")
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

/**
 * Resource-free tauri configuration for the headless compile.
 *
 * `bundle.resources` in `src-tauri/tauri.conf.json` globs three sidecar
 * `node_modules` trees. pnpm materializes those as symlinks into its
 * content-addressed store, so `tauri-build`'s resource walk follows the links
 * and copies ~149k real files (2.9 GB) into `target/<profile>/_up_/` — with a
 * plain `std::fs::copy` per file, unconditionally, every time the build script
 * re-runs. It re-runs on every edit to `src-tauri/src/lib.rs` (a declared
 * `rerun-if-changed` input), which spends 4-5 silent minutes of this build on a
 * payload the headless binary never reads: it resolves no Tauri resource paths,
 * and `launchEnvironment` hands the brain, agent sidecar, MCP sidecar, VS Code
 * host and code-server extension their absolute repo paths instead.
 *
 * Emptying the list applies to the headless compile only; `pnpm tauri dev` and
 * the packaged bundles still stage the real resources. `tauri-build` declares
 * `rerun-if-env-changed=TAURI_CONFIG`, so alternating between a headless build
 * and a desktop build re-runs the build script — and pays the copy once — on
 * each switch.
 */
const HEADLESS_TAURI_CONFIG = JSON.stringify({ bundle: { resources: [] } })

function buildSteps(pnpmBin) {
  return [
    { command: pnpmBin, args: ["cli:native-hosts:build"] },
    { command: pnpmBin, args: ["support:docs:build"] },
    { command: pnpmBin, args: ["exec", "node", "scripts/build/build-cli.mjs"] },
    { command: pnpmBin, args: ["exec", "node", "scripts/build/build-mcp-sidecar.mjs"] },
    {
      command: pnpmBin,
      args: ["exec", "node", "scripts/build/build-vscode-ext-host-sidecar.mjs"],
    },
    { command: pnpmBin, args: ["sidecar:codeserver-agent:build"] },
    {
      command: pnpmBin,
      args: ["terminal-host:prepare:dev"],
      env: { TAURI_CONFIG: HEADLESS_TAURI_CONFIG },
    },
  ]
}

function launchArgs(options) {
  const args = ["serve", "--port", String(options.port)]
  if (options.localDebug) args.push("--bind-loopback")
  if (options.advertiseUrl) args.push("--advertise-url", options.advertiseUrl)
  if (options.allowRemoteTerminal) args.push("--allow-remote-terminal")
  if (options.browserListenerPort) {
    args.push("--browser-listener-port", String(options.browserListenerPort))
  }
  return args
}

function pairArgs(options) {
  const args = ["pair", "--device-name", options.deviceName || "browser"]
  if (options.advertiseUrl) args.push("--advertise-url", options.advertiseUrl)
  args.push("--port", String(options.port))
  if (options.tenantId) args.push("--tenant-id", options.tenantId)
  return args
}

/**
 * `devices enroll-browser` — a different code, for a different plane, carrying
 * a different capability set.
 *
 * `pair` mints an Owner invitation (`cgnp3|`) that the app's pair screen
 * spends. This mints a browser-companion enrollment (`cgnb1|`) that the
 * extension spends against the plaintext loopback listener for exactly
 * `browser.submit` + `browser.read-own`. Neither is usable where the other
 * belongs, which is why they share neither a subcommand nor a header.
 */
function browserEnrollArgs(options) {
  const args = ["devices", "enroll-browser"]
  if (options.browserListenerPort) {
    args.push("--browser-listener-port", String(options.browserListenerPort))
  }
  if (options.tenantId) args.push("--tenant-id", options.tenantId)
  return args
}

function launchEnvironment(options, paths, secret, env, localDebug) {
  const childEnv = {
    ...env,
    COGNIA_ALLOWED_WEB_ORIGINS:
      env.COGNIA_ALLOWED_WEB_ORIGINS?.trim() || DEFAULT_DEVELOPMENT_WEB_ORIGINS,
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
  if (options.workspacesDir) childEnv.COGNIA_WORKSPACES_DIR = options.workspacesDir
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
    "COGNIA_ALLOWED_WEB_ORIGINS",
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
    "COGNIA_WORKSPACES_DIR",
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

async function readMasterKey(secret) {
  if (secret.kind === "inline") return Buffer.from(secret.value, "hex")
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
  return Buffer.from(value, "hex")
}

async function validateSecret(secret, dataDir, recoverSecretStore = false) {
  const key = await readMasterKey(secret)
  const storePath = path.join(dataDir, "cognia", "secret-store.enc")
  let encrypted
  try {
    encrypted = await readFile(storePath)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw new PreflightError(
      `encrypted secret store is not readable at ${storePath}: ${error.message}`
    )
  }
  if (encrypted.length === 0) return
  try {
    if (encrypted.length < 28) throw new Error("encrypted blob is too short")
    const nonce = encrypted.subarray(0, 12)
    const authTag = encrypted.subarray(encrypted.length - 16)
    const ciphertext = encrypted.subarray(12, encrypted.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", key, nonce)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const entries = JSON.parse(plaintext.toString("utf8"))
    if (entries === null || Array.isArray(entries) || typeof entries !== "object") {
      throw new Error("decrypted payload is not a secret map")
    }
  } catch {
    if (recoverSecretStore) {
      const preservedPath = `${storePath}.unreadable-${Date.now()}`
      await rename(storePath, preservedPath).catch((error) => {
        throw new PreflightError(
          `cannot preserve unreadable secret store at ${storePath}: ${error.message}`
        )
      })
      process.stderr.write(
        `Preserved unreadable secret store at ${preservedPath}; paired devices and stored ` +
          `credentials must be configured again.\n`
      )
      return
    }
    throw new PreflightError(
      `master key cannot decrypt the encrypted secret store at ${storePath}; restore the original ` +
        `key or rerun with --recover-secret-store to preserve the unreadable store and start empty`
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

async function prepareSecret(secret, dataDir, recoverSecretStore = false) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (secret.kind === "inline") {
    await validateSecret(secret, dataDir, recoverSecretStore)
    return
  }
  await mkdir(path.dirname(secret.path), { recursive: true, mode: 0o700 })
  try {
    await access(secret.path, fsConstants.R_OK)
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new PreflightError(
        `master key file is not readable at ${secret.path}: ${error.message}`
      )
    }
    const storePath = path.join(dataDir, "cognia", "secret-store.enc")
    try {
      const store = await stat(storePath)
      if (store.size > 0) {
        throw new PreflightError(
          `refusing to create a new master key at ${secret.path} because the existing encrypted ` +
            `secret store at ${storePath} requires its original key; restore the original key or ` +
            `choose a new --data-dir`
        )
      }
    } catch (storeError) {
      if (storeError instanceof PreflightError) throw storeError
      if (storeError.code !== "ENOENT") {
        throw new PreflightError(
          `cannot inspect encrypted secret store at ${storePath}: ${storeError.message}`
        )
      }
    }
  }
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
  await validateSecret(secret, dataDir, recoverSecretStore)
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
    const buildEnv = { ...env, ...step.env }
    delete buildEnv.COGNIA_MASTER_KEY
    await runProcess(step.command, step.args, `headless build step ${index + 1}`, buildEnv)
  }
}

async function buildServerArtifact(paths, env) {
  const buildEnv = { ...env, TAURI_CONFIG: HEADLESS_TAURI_CONFIG }
  delete buildEnv.COGNIA_MASTER_KEY
  if (path.basename(path.dirname(paths.server)) === "debug") {
    buildEnv.CARGO_TARGET_DIR = path.dirname(path.dirname(paths.server))
  }
  await runProcess(
    env.COGNIA_HEADLESS_PNPM_BIN || "pnpm",
    ["terminal-host:prepare:dev"],
    "cognia-server rebuild",
    buildEnv
  )
}

/**
 * `cgnb1|` — encoded here rather than in Rust, deliberately.
 *
 * The decoder the extension actually runs lives in
 * `packages/companion-client/src/browser-enrollment-payload.ts`, and a second
 * encoder in Rust would be a wire format free to drift from it with nothing
 * watching. This copy is pinned to that file from both sides: the package's
 * own suite asserts the exact string for a fixed payload, and so does
 * `headless.test.mjs`, so changing either encoder turns one of them red.
 */
function encodeBrowserEnrollment(issue) {
  const payload = JSON.stringify({
    base: issue.baseUrl,
    tenant: issue.tenantId,
    enrollment: issue.enrollment,
    exp: issue.expiresAtMs,
  })
  return `cgnb1|${Buffer.from(payload, "utf8").toString("base64url")}`
}

/**
 * `http://` on a loopback host — mirrors the decoder's `isLoopbackHttpOrigin`.
 *
 * Checked here so a base URL the extension would refuse fails in the terminal
 * that produced it, with the reason, instead of inside a side panel that only
 * knows the code is bad.
 */
function isLoopbackHttpOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:") return false
  const host = url.hostname
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Read the `BrowserEnrollmentIssue` JSON the native command prints.
 *
 * Every field is checked before anything is encoded: a `cgnb1|` string built
 * from a partial issue decodes as "invalid" in the extension and says nothing
 * about where it came from, which is the failure this whole action exists to
 * avoid.
 */
function parseBrowserEnrollmentIssue(output) {
  const stale = "; rebuild or redeploy cognia-server before enrolling a browser"
  let issue
  try {
    issue = JSON.parse(output.trim())
  } catch {
    throw new PreflightError(`browser enrollment issuer did not return JSON${stale}`)
  }
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
    throw new PreflightError(`browser enrollment issuer did not return an issue object${stale}`)
  }
  for (const field of ["enrollment", "baseUrl", "tenantId"]) {
    if (typeof issue[field] !== "string" || issue[field].length === 0) {
      throw new PreflightError(`browser enrollment issuer omitted ${field}${stale}`)
    }
  }
  if (typeof issue.expiresAtMs !== "number" || !Number.isFinite(issue.expiresAtMs)) {
    throw new PreflightError(`browser enrollment issuer omitted expiresAtMs${stale}`)
  }
  if (!isLoopbackHttpOrigin(issue.baseUrl)) {
    throw new PreflightError(
      `browser enrollment names ${issue.baseUrl}, which a browser extension cannot use; ` +
        `the enrollment must advertise the plaintext loopback listener`
    )
  }
  if (issue.expiresAtMs <= Date.now()) {
    throw new PreflightError(
      `browser enrollment expired at ${new Date(issue.expiresAtMs).toISOString()} before it was ` +
        `printed; check this machine's clock`
    )
  }
  return issue
}

async function runBrowserEnrollProcess(command, args, env) {
  let result
  try {
    result = await execa(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      reject: false,
    })
  } catch (error) {
    throw new PreflightError(
      `cognia-server browser enrollment issuer could not start: ${error.message}`
    )
  }
  // Forwarded before the exit check, not after: the native command's refusals
  // — an unbound listener, a port held by another deployment — are the whole
  // diagnosis, and swallowing them leaves only an exit code.
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`)
  }
  if (result.exitCode !== 0 || result.signal) {
    const status = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`
    throw new PreflightError(`cognia-server browser enrollment issuer failed with ${status}`)
  }
  const issue = parseBrowserEnrollmentIssue(result.stdout || "")
  process.stdout.write(`${encodeBrowserEnrollment(issue)}\n`)
  process.stderr.write(
    `Paste it into the Cognia browser extension. It reaches ${issue.baseUrl} and expires at ` +
      `${new Date(issue.expiresAtMs).toISOString()}.\n` +
      `The running host must also allow the extension's own origin: ` +
      `chrome-extension://<id> in COGNIA_ALLOWED_WEB_ORIGINS, or every request answers 403.\n`
  )
}

async function runPairProcess(command, args, env) {
  let result
  try {
    result = await execa(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      reject: false,
    })
  } catch (error) {
    throw new PreflightError(
      `cognia-server pairing invitation issuer could not start: ${error.message}`
    )
  }
  if (result.exitCode !== 0 || result.signal) {
    const status = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`
    throw new PreflightError(`cognia-server pairing invitation issuer failed with ${status}`)
  }
  const output = result.stdout || ""
  if (!/cgnp3\|/.test(output)) {
    const emittedVersion = /cgnp(\d+)\|/.exec(output)?.[1]
    throw new PreflightError(
      `pairing issuer ${
        emittedVersion ? `returned cgnp${emittedVersion}` : "did not return a Cognia invitation"
      }; expected a cgnp3 invitation. Rebuild or redeploy cognia-server before pairing.`
    )
  }
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`)
  if (result.stderr) {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`)
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
  if (options.action === "pair") {
    await prepareSecret(secret, paths.dataDir)
    if (!options.skipBuild) await buildServerArtifact(paths, process.env)
    await validateServerArtifact(paths)
    await runPairProcess(
      paths.server,
      pairArgs(options),
      tokenEnvironment(paths, secret, process.env)
    )
    return
  }
  if (options.action === "browser-enroll") {
    await prepareSecret(secret, paths.dataDir)
    if (!options.skipBuild) await buildServerArtifact(paths, process.env)
    await validateServerArtifact(paths)
    await runBrowserEnrollProcess(
      paths.server,
      browserEnrollArgs(options),
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
    await validateSecret(secret, paths.dataDir)
    await validateArtifacts(paths)
    process.stdout.write(
      `Headless development artifacts are ready.\n` +
        `Next.js and Tauri WebView: not started.\n` +
        `Companion URL: https://127.0.0.1:${options.port}\n`
    )
    return
  }
  await prepareSecret(secret, paths.dataDir, options.recoverSecretStore)
  if (!options.skipBuild) {
    await buildHeadlessArtifacts(process.env)
  }
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
