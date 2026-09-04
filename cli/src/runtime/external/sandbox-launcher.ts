import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  bundledCandidates,
  defaultNativeCandidates,
  findNativeBinary,
  isDevCheckout as isRepoCheckout,
  isExecutable as isExecutableFile,
  nativeBinaryName,
} from "../native-binary"

import type { ExternalAgentLaunch, NodeExternalAgentSpawnConfig } from "./node-backend"
import { toolHostRuntimeDir } from "../../agent/tool-host/protocol"
import {
  SANDBOX_SUPPORTED_PLATFORMS,
  agentStateWritableRoots as policyAgentStateWritableRoots,
  isAgentStateFileRoot,
} from "@/lib/ai/agent/external/security-policy"

/** Base name of the launcher binary built from `crates/cognia-automation`. */
const LAUNCHER_BASE_NAME = "cognia-external-agent-launcher"

export interface SandboxLauncherRuntime {
  platform: NodeJS.Platform
  homedir: string
  candidates: string[]
  isExecutable: (candidate: string) => boolean
  ensureDir?: (candidate: string) => void
  ensureFile?: (candidate: string) => void
  /** True when running from a repo checkout, which unlocks the build hint. */
  isDevCheckout?: () => boolean
}

/** Platform-correct launcher filename. `platform` is a parameter so the Windows
 * spelling is reachable from a test on any host. */
export const launcherName = (platform: NodeJS.Platform = process.platform): string =>
  nativeBinaryName(LAUNCHER_BASE_NAME, platform)

/** Resolve launcher locations for both a single-file bundle and a split `chunks/` bundle. */
export function bundledLauncherCandidates(moduleUrl: string, name: string): string[] {
  return bundledCandidates(moduleUrl, name)
}

function defaultCandidates(): string[] {
  return defaultNativeCandidates({
    base: LAUNCHER_BASE_NAME,
    envVar: "COGNIA_EXTERNAL_AGENT_LAUNCHER",
    moduleUrl: import.meta.url,
  })
}

const isExecutable = isExecutableFile

/** Is this an in-repo checkout (where `pnpm cli:external-host:build` is a real
 * remedy) rather than an installed CLI (where it is noise)? */
export function isDevCheckout(): boolean {
  return isRepoCheckout()
}

/**
 * Why external agents cannot start, phrased for whoever is actually reading it.
 *
 * The build command is a maintainer instruction and is meaningless to someone
 * running an installed `cognia-agent`, so it is appended only in a checkout.
 */
export function sandboxLauncherUnavailableMessage(command: string, devCheckout: boolean): string {
  const base =
    `Can't launch "${command}": the external-agent sandbox launcher is unavailable. ` +
    `Cognia only runs external agents inside a strict sandbox and never falls back to an ` +
    `unsandboxed process. Reinstall cognia-agent, or point COGNIA_EXTERNAL_AGENT_LAUNCHER at a ` +
    `built launcher.`
  return devCheckout ? `${base} (repo checkout: run \`pnpm cli:external-host:build\`)` : base
}

/**
 * The first executable launcher among the candidates, or `undefined`. Exported
 * so `/doctor` can report sandbox readiness WITHOUT attempting a spawn — the
 * external command being on PATH says nothing about whether we can sandbox it.
 */
export function findSandboxLauncher(
  runtime: Pick<SandboxLauncherRuntime, "candidates" | "isExecutable"> = {
    candidates: defaultCandidates(),
    isExecutable,
  }
): string | undefined {
  return findNativeBinary(runtime.candidates, runtime.isExecutable)
}

/**
 * Can this platform host external agents at all? Fails closed off macOS/Linux.
 *
 * The platform list is the shared security policy's, not a literal here: the
 * settings UI has to be able to say "external agents cannot run on this
 * machine" BEFORE a user configures one, and it cannot import this Node-only
 * module to find out.
 */
export function sandboxSupportsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return (SANDBOX_SUPPORTED_PLATFORMS as readonly string[]).includes(platform)
}

export function buildSandboxLauncherArgs(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string[] {
  if (!config.cwd) throw new Error("external-agent sandbox requires a working directory")
  const writable = [config.cwd, ...agentStateWritableRoots(config, homedir), toolHostRuntimeDir()]
  return [
    "--cwd",
    config.cwd,
    ...writable.flatMap((root) => ["--writable", root]),
    "--readable",
    homedir,
    "--network",
    "--",
    config.command,
    ...(config.args ?? []),
  ]
}

/**
 * The agent's own state directories, absolute.
 *
 * The RULES live in `protocol/external-agent-security-policy.json` (shared with
 * the Rust launcher, which keeps compiled-in literals and is checked against
 * the same file by `pnpm audit:agent-capabilities`). Only the join to the real
 * home directory happens here. While this list was hand-maintained in two
 * places it lacked an OpenCode rule on both sides, so `opencode serve` could
 * not persist a session inside the sandbox and resume started over every time.
 */
function agentStateWritableRoots(config: NodeExternalAgentSpawnConfig, homedir: string): string[] {
  return policyAgentStateWritableRoots(config.command, config.args ?? []).map((root) =>
    path.join(homedir, ...root.split("/"))
  )
}

function agentStateDirectoryRoots(config: NodeExternalAgentSpawnConfig, homedir: string): string[] {
  return agentStateWritableRoots(config, homedir).filter((root) => !isAgentStateFileRoot(root))
}

function agentStateFileRoots(config: NodeExternalAgentSpawnConfig, homedir: string): string[] {
  return agentStateWritableRoots(config, homedir).filter((root) => isAgentStateFileRoot(root))
}

/** The real host runtime. Exported so its fs shims are directly testable — as an
 * inline default-parameter literal they could only be reached by a call that
 * actually spawned an agent and wrote to the user's home. */
export function defaultSandboxRuntime(): SandboxLauncherRuntime {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    candidates: defaultCandidates(),
    isExecutable,
    ensureDir: (candidate) => fs.mkdirSync(candidate, { recursive: true }),
    ensureFile: (candidate) => fs.closeSync(fs.openSync(candidate, "a", 0o600)),
    isDevCheckout,
  }
}

export async function resolveSandboxedExternalAgentLaunch(
  config: NodeExternalAgentSpawnConfig,
  runtime: SandboxLauncherRuntime = defaultSandboxRuntime()
): Promise<ExternalAgentLaunch> {
  if (!sandboxSupportsPlatform(runtime.platform)) {
    throw new Error(
      `External agents are not available on ${runtime.platform}: they require a strict sandbox ` +
        `(macOS Seatbelt or Linux bubblewrap), and Cognia never runs them unsandboxed.`
    )
  }
  const launcher = findSandboxLauncher(runtime)
  if (!launcher) {
    throw new Error(
      sandboxLauncherUnavailableMessage(config.command, runtime.isDevCheckout?.() ?? false)
    )
  }
  for (const root of agentStateDirectoryRoots(config, runtime.homedir)) runtime.ensureDir?.(root)
  runtime.ensureDir?.(toolHostRuntimeDir())
  for (const root of agentStateFileRoots(config, runtime.homedir)) runtime.ensureFile?.(root)
  return {
    command: launcher,
    args: buildSandboxLauncherArgs(config, runtime.homedir),
  }
}
