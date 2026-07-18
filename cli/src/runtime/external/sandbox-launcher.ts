import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { ExternalAgentLaunch, NodeExternalAgentSpawnConfig } from "./node-backend"

export interface SandboxLauncherRuntime {
  platform: NodeJS.Platform
  homedir: string
  candidates: string[]
  isExecutable: (candidate: string) => boolean
  ensureDir?: (candidate: string) => void
  ensureFile?: (candidate: string) => void
}

const launcherName = (): string =>
  process.platform === "win32"
    ? "cognia-external-agent-launcher.exe"
    : "cognia-external-agent-launcher"

/** Resolve launcher locations for both a single-file bundle and a split `chunks/` bundle. */
export function bundledLauncherCandidates(moduleUrl: string, name: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl))
  return [path.join(moduleDir, name), path.join(moduleDir, "..", name)]
}

function defaultCandidates(): string[] {
  const name = launcherName()
  const explicit = process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER
  return [
    explicit,
    ...bundledLauncherCandidates(import.meta.url, name),
    path.join(path.dirname(process.execPath), name),
    path.join(process.cwd(), "cli", "dist", "native", `${process.platform}-${process.arch}`, name),
    path.join(process.cwd(), "target", "release", name),
    path.join(process.cwd(), "target", "debug", name),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function buildSandboxLauncherArgs(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): string[] {
  if (!config.cwd) throw new Error("external-agent sandbox requires a working directory")
  const writable = [config.cwd, ...agentStateWritableRoots(config, homedir)]
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

function agentStateWritableRoots(config: NodeExternalAgentSpawnConfig, homedir: string): string[] {
  const command = config.command.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "")
  const npxPackage =
    command === "npx" ? (config.args ?? []).find((arg) => !arg.startsWith("-")) : undefined
  const target = npxPackage ?? command
  const roots: string[] = []
  if (/codex/.test(target)) roots.push(path.join(homedir, ".codex"))
  if (/claude/.test(target)) {
    roots.push(
      path.join(homedir, ".claude"),
      path.join(homedir, ".claude.json"),
      path.join(homedir, ".claude.json.backup")
    )
  }
  if (/gemini/.test(target)) roots.push(path.join(homedir, ".gemini"))
  if (/qwen/.test(target)) roots.push(path.join(homedir, ".qwen"))
  if (target === "pi-acp" || command === "pi") roots.push(path.join(homedir, ".pi"))
  if (/copilot/.test(target)) {
    roots.push(path.join(homedir, ".copilot"), path.join(homedir, ".cache", "copilot"))
  }
  if (/kiro/.test(target)) roots.push(path.join(homedir, ".kiro"))
  if (/droid|factory/.test(target)) roots.push(path.join(homedir, ".factory"))
  if (/cursor/.test(target)) roots.push(path.join(homedir, ".cursor"))
  if (command === "npx") roots.push(path.join(homedir, ".npm"))
  return roots
}

function agentStateDirectoryRoots(config: NodeExternalAgentSpawnConfig, homedir: string): string[] {
  return agentStateWritableRoots(config, homedir).filter(
    (root) => !path.basename(root).startsWith(".claude.json")
  )
}

function agentStateFileRoots(config: NodeExternalAgentSpawnConfig, homedir: string): string[] {
  return agentStateWritableRoots(config, homedir).filter((root) =>
    path.basename(root).startsWith(".claude.json")
  )
}

export async function resolveSandboxedExternalAgentLaunch(
  config: NodeExternalAgentSpawnConfig,
  runtime: SandboxLauncherRuntime = {
    platform: process.platform,
    homedir: os.homedir(),
    candidates: defaultCandidates(),
    isExecutable,
    ensureDir: (candidate) => fs.mkdirSync(candidate, { recursive: true }),
    ensureFile: (candidate) => fs.closeSync(fs.openSync(candidate, "a", 0o600)),
  }
): Promise<ExternalAgentLaunch> {
  if (runtime.platform !== "darwin" && runtime.platform !== "linux") {
    throw new Error(`strict external-agent sandbox hosting is not available on ${runtime.platform}`)
  }
  const launcher = runtime.candidates.find(runtime.isExecutable)
  if (!launcher) {
    throw new Error(
      "external-agent sandbox launcher is unavailable; run `pnpm cli:external-host:build` or set COGNIA_EXTERNAL_AGENT_LAUNCHER"
    )
  }
  for (const root of agentStateDirectoryRoots(config, runtime.homedir)) runtime.ensureDir?.(root)
  for (const root of agentStateFileRoots(config, runtime.homedir)) runtime.ensureFile?.(root)
  return {
    command: launcher,
    args: buildSandboxLauncherArgs(config, runtime.homedir),
  }
}
