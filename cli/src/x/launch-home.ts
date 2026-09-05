/**
 * Isolated agent homes for `cognia-agent x`.
 *
 * Claude Code keeps its state under `~/.claude` (or `CLAUDE_CONFIG_DIR`),
 * Codex under `~/.codex` (or `CODEX_HOME`). A launch that shares those
 * directories with the user's own agent sessions is not isolated at all: it
 * reads the same login, writes the same session list, and its "use this
 * API key?" answers land in the user's real config. A launch that fails
 * over there can also take the user's own subscription session down with it.
 *
 * So by default every launch runs in a profile home owned by cognia:
 *
 *   <cliHome>/x/<agent>/<profile>/
 *
 * `profile` defaults to `default`, so `--resume` keeps working between
 * launches of the same profile, and `--profile <name>` gives one agent
 * several fully separate instances. `--shared-home` opts back into the
 * user's own directory for the cases where its settings are wanted.
 *
 * Nothing under the user's real home is ever read or written by this module.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { renderCodexConfigToml } from "./codex-config"
import type { SupportedAgent } from "./detect-cli"

export const DEFAULT_PROFILE = "default"

/** A profile is a single path segment: no separators, no dot-dot, no blanks. */
export const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Environment variable each agent reads its home from. */
export const AGENT_HOME_ENV: Record<SupportedAgent, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
}

export type LaunchHomePlan =
  | {
      mode: "isolated"
      profile: string
      dir: string
      /** Variables that point the agent at the profile home. */
      env: Record<string, string>
    }
  | {
      mode: "shared"
      /** The user's own home, for the banner only. Never written here. */
      dir: string
      env: Record<string, never>
    }

export interface LaunchHomeInput {
  agent: SupportedAgent
  /** The CLI data root (`~/.cognia`). */
  cliHome: string
  /** `--profile`. Defaults to `default`. */
  profile?: string
  /** `--shared-home`: use the user's own agent directory. */
  shared?: boolean
  /** For the Codex profile's `config.toml`. */
  gatewayBaseUrl: string
  model?: string
  env?: Record<string, string | undefined>
  homedir?: string
  fs?: LaunchHomeFs
}

/** The filesystem slice this module touches (tests substitute an in-memory one). */
export interface LaunchHomeFs {
  existsSync: (path: string) => boolean
  mkdirSync: (path: string, options: { recursive: true; mode: number }) => unknown
  writeFileSync: (path: string, data: string, options: { mode: number }) => void
}

export class LaunchProfileError extends Error {
  constructor(profile: string) {
    super(
      `profile "${profile}" is not a valid name: use 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit`
    )
    this.name = "LaunchProfileError"
  }
}

/** Where `<agent>`'s `<profile>` lives under the CLI home. */
export function launchHomeDir(cliHome: string, agent: SupportedAgent, profile: string): string {
  return path.join(cliHome, "x", agent, profile)
}

/** The directory a shared launch would use, for display. */
export function sharedHomeDir(
  agent: SupportedAgent,
  env: Record<string, string | undefined>,
  homedir: string
): string {
  const explicit = env[AGENT_HOME_ENV[agent]]?.trim()
  if (explicit) return explicit
  return path.join(homedir, agent === "claude" ? ".claude" : ".codex")
}

/**
 * Claude Code's first-run wizard (theme, onboarding) belongs to a person
 * setting up their own install, not to a launch that already knows its
 * gateway. Seed the profile so the agent starts on the task.
 */
const CLAUDE_PROFILE_SEED = {
  hasCompletedOnboarding: true,
}

/**
 * Resolve, and for an isolated launch create, the agent's home.
 */
export function resolveLaunchHome(input: LaunchHomeInput): LaunchHomePlan {
  const env = input.env ?? process.env
  const homedir = input.homedir ?? os.homedir()
  const fsImpl: LaunchHomeFs = input.fs ?? fs

  if (input.shared) {
    return { mode: "shared", dir: sharedHomeDir(input.agent, env, homedir), env: {} }
  }

  const profile = input.profile?.trim() || DEFAULT_PROFILE
  if (!PROFILE_PATTERN.test(profile)) throw new LaunchProfileError(profile)

  const dir = launchHomeDir(input.cliHome, input.agent, profile)
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 })

  if (input.agent === "claude") {
    const seed = path.join(dir, ".claude.json")
    if (!fsImpl.existsSync(seed)) {
      fsImpl.writeFileSync(seed, `${JSON.stringify(CLAUDE_PROFILE_SEED, null, 2)}\n`, {
        mode: 0o600,
      })
    }
  } else {
    // The `-c` overrides on argv still win. The file is what `codex resume`
    // and any tool that reads CODEX_HOME directly see.
    const config = path.join(dir, "config.toml")
    if (!fsImpl.existsSync(config)) {
      fsImpl.writeFileSync(config, renderCodexConfigToml(input.gatewayBaseUrl, input.model), {
        mode: 0o600,
      })
    }
  }

  return {
    mode: "isolated",
    profile,
    dir,
    env: { [AGENT_HOME_ENV[input.agent]]: dir },
  }
}

/** One line for the launch banner. */
export function describeLaunchHome(plan: LaunchHomePlan): string {
  return plan.mode === "isolated"
    ? `isolated profile "${plan.profile}" (${plan.dir})`
    : `shared with your own agent (${plan.dir})`
}
