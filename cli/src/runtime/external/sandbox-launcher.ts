import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ExternalAgentLaunch, NodeExternalAgentSpawnConfig } from "./node-backend"

export interface SandboxLauncherRuntime {
  platform: NodeJS.Platform
  homedir: string
  candidates: string[]
  isExecutable: (candidate: string) => boolean
}

const launcherName = (): string =>
  process.platform === "win32"
    ? "cognia-external-agent-launcher.exe"
    : "cognia-external-agent-launcher"

function defaultCandidates(): string[] {
  const name = launcherName()
  const explicit = process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER
  return [
    explicit,
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
  return [
    "--cwd",
    config.cwd,
    "--writable",
    config.cwd,
    "--readable",
    homedir,
    "--network",
    "--",
    config.command,
    ...(config.args ?? []),
  ]
}

export async function resolveSandboxedExternalAgentLaunch(
  config: NodeExternalAgentSpawnConfig,
  runtime: SandboxLauncherRuntime = {
    platform: process.platform,
    homedir: os.homedir(),
    candidates: defaultCandidates(),
    isExecutable,
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
  return {
    command: launcher,
    args: buildSandboxLauncherArgs(config, runtime.homedir),
  }
}
