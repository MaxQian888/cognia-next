/**
 * Installing a missing external-agent CLI from the failure page.
 *
 * When {@link connectBackend} fails at the `command` stage — the agent's binary
 * isn't installed — the failure page offers to install it instead of only
 * telling the user to. This module is the honest, data-driven half of that:
 *
 *  - {@link INSTALL_PLANS} maps each agent binary to its *officially supported*
 *    install methods, ordered by preference (a package-manager install first,
 *    then the vendor's curl installer). Nothing is inferred from prose.
 *  - {@link pickInstallMethod} chooses the first method whose prerequisite tools
 *    are actually present, so a curl installer is never offered without `curl`
 *    and an npm install is never offered without `npm`.
 *  - {@link runInstall} runs the chosen method as a normal (unsandboxed) child —
 *    it is the user's own approved install command, not the untrusted agent — and
 *    streams its output, with the same enriched PATH the resolver uses so
 *    `npm` / `brew` / `curl` are found even from a minimal environment.
 *
 * Agents run through `npx` (Claude Code, Gemini, Qwen, the Codex ACP shim, Pi)
 * need no install — `npx` fetches on demand — so they have no plan; a missing
 * `npx` means Node itself is absent, which we can only point at docs for.
 */
import { spawn as nodeSpawn } from "node:child_process"
import readline from "node:readline"

import { resolveAgentSearchPath } from "../../runtime/external/agent-path"

export type InstallMethodKind = "npm" | "pnpm" | "brew" | "curl"

export interface InstallMethod {
  kind: InstallMethodKind
  /** Short label for the method, shown on the install choice (e.g. "npm"). */
  label: string
  /** The exact command line shown to the user before it runs. */
  display: string
  /** The executable actually spawned. */
  command: string
  args: string[]
  /** Bare commands that must ALL resolve before this method may be offered. */
  requires: string[]
}

export interface InstallPlan {
  /** The agent binary this plan installs (the command that was missing). */
  command: string
  /** Agent display name, used in the prompt ("Install Factory Droid?"). */
  name: string
  /** Install methods, most-preferred first. May be empty (docs-only agents). */
  methods: InstallMethod[]
  /** Where to read more when no method can run here. */
  docsUrl?: string
}

const npm = (label: string, pkg: string): InstallMethod => ({
  kind: "npm",
  label: "npm",
  display: `npm install -g ${pkg}`,
  command: "npm",
  args: ["install", "-g", pkg],
  requires: ["npm"],
})

const brew = (formula: string): InstallMethod => ({
  kind: "brew",
  label: "Homebrew",
  display: `brew install ${formula}`,
  command: "brew",
  args: ["install", formula],
  requires: ["brew"],
})

/** A vendor curl installer. `shell` is the interpreter the official one-liner
 * pipes into; it is required alongside `curl` so the method is hidden when
 * either is absent. */
const curl = (url: string, shell: "sh" | "bash", curlFlags = "-fsSL"): InstallMethod => {
  const pipeline = `curl ${curlFlags} ${url} | ${shell}`
  return {
    kind: "curl",
    label: `${shell} installer`,
    display: pipeline,
    command: shell,
    args: ["-c", pipeline],
    requires: ["curl", shell],
  }
}

/**
 * Officially-supported install methods per agent binary. Keyed by the bare
 * command a preset launches, so a `command`-stage failure resolves its plan
 * directly from `failure.command`.
 */
export const INSTALL_PLANS: Record<string, InstallPlan> = {
  codex: {
    command: "codex",
    name: "OpenAI Codex CLI",
    methods: [npm("npm", "@openai/codex"), brew("codex")],
    docsUrl: "https://developers.openai.com/codex/cli",
  },
  copilot: {
    command: "copilot",
    name: "GitHub Copilot CLI",
    methods: [npm("npm", "@github/copilot")],
    docsUrl: "https://docs.github.com/copilot/reference/copilot-cli-reference/acp-server",
  },
  opencode: {
    command: "opencode",
    name: "OpenCode",
    methods: [
      npm("npm", "opencode-ai"),
      brew("sst/tap/opencode"),
      curl("https://opencode.ai/install", "bash"),
    ],
    docsUrl: "https://opencode.ai/docs",
  },
  "cursor-agent": {
    command: "cursor-agent",
    name: "Cursor CLI",
    methods: [curl("https://cursor.com/install", "bash", "-fsS")],
    docsUrl: "https://docs.cursor.com/en/cli/overview",
  },
  droid: {
    command: "droid",
    name: "Factory Droid",
    methods: [curl("https://app.factory.ai/cli", "sh")],
    docsUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
  },
  "kiro-cli": {
    // Kiro's installer requires an interactive AWS Builder ID / IAM Identity
    // Center browser sign-in, so it cannot run unattended — docs only.
    command: "kiro-cli",
    name: "Kiro CLI",
    methods: [],
    docsUrl: "https://kiro.dev/docs/cli/installation/",
  },
  npx: {
    // A missing `npx` means Node itself is absent; installing Node is out of
    // scope for an in-TUI installer, so this is docs-only.
    command: "npx",
    name: "Node.js (provides npx)",
    methods: [],
    docsUrl: "https://nodejs.org/en/download",
  },
}

/** The install plan for a missing command, or `undefined` when none is known. */
export function resolveInstallPlan(command: string | undefined): InstallPlan | undefined {
  if (!command) return undefined
  return INSTALL_PLANS[command.trim()]
}

/**
 * The first method in `plan` whose prerequisite tools all resolve, or
 * `undefined` when nothing installable is available here (so the caller falls
 * back to the docs link). `commandExists` is the enriched resolver, injected.
 */
export async function pickInstallMethod(
  plan: InstallPlan,
  commandExists: (command: string) => Promise<boolean>
): Promise<InstallMethod | undefined> {
  for (const method of plan.methods) {
    const checks = await Promise.all(method.requires.map((tool) => commandExists(tool)))
    if (checks.every(Boolean)) return method
  }
  return undefined
}

export interface RunInstallDeps {
  method: InstallMethod
  /** Streamed a line at a time as the installer writes to stdout/stderr. */
  onLine?: (line: string) => void
  /** Injectable for tests; defaults to `child_process.spawn`. */
  spawnFn?: typeof nodeSpawn
  /** Injectable env; defaults to the ambient env with an enriched PATH so
   * `npm` / `brew` / `curl` resolve from a minimal launching environment. */
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface RunInstallResult {
  ok: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
}

/**
 * Run one install method to completion. Never rejects — the failure page needs a
 * value it can render, and a spawn error (`ENOENT`, a shell that isn't there) is
 * a normal "install failed" outcome, not an exception.
 */
export async function runInstall(deps: RunInstallDeps): Promise<RunInstallResult> {
  const spawn = deps.spawnFn ?? nodeSpawn
  const env = deps.env ?? { ...process.env, PATH: resolveAgentSearchPath() }
  return await new Promise<RunInstallResult>((resolve) => {
    let settled = false
    const done = (result: RunInstallResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      child = spawn(deps.method.command, deps.method.args, {
        env,
        ...(deps.cwd ? { cwd: deps.cwd } : {}),
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      deps.onLine?.(error instanceof Error ? error.message : String(error))
      done({ ok: false, exitCode: null, signal: null })
      return
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue
      readline.createInterface({ input: stream }).on("line", (line) => deps.onLine?.(line))
    }
    child.once("error", (error) => {
      deps.onLine?.(error instanceof Error ? error.message : String(error))
      done({ ok: false, exitCode: null, signal: null })
    })
    child.once("exit", (code, signal) => {
      done({ ok: code === 0, exitCode: code, signal })
    })
  })
}
