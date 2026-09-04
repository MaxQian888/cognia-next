/**
 * `cognia-agent update` and `cognia-agent update check`.
 *
 * The CLI never rewrites itself. It works out which package manager owns the
 * install and, once the user confirms, delegates to that package manager. When
 * the source is ambiguous it prints every candidate command instead of picking
 * one, because a global install command that silently targets the wrong prefix
 * is worse than no command at all.
 *
 * Three installs are refused outright rather than upgraded:
 *  - a development checkout, where the binary points into a repo,
 *  - an `npx` style temporary invocation, which owns nothing to upgrade,
 *  - the sidecar the desktop app bundles, which ships with the app.
 *
 * Elevation is never requested. If a global prefix needs root, the user runs
 * the printed command themselves.
 */

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ParsedArgs } from "./args"
import type { OutputSink } from "./output"
import { VERSION } from "../version"

export const CLI_PACKAGE = "@cognia/agent-cli"
export const DEFAULT_REGISTRY = "https://registry.npmjs.org"

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"]

/** The upgrade command for one package manager. */
export function upgradeCommand(manager: PackageManager, version = "latest"): string {
  const spec = `${CLI_PACKAGE}@${version}`
  switch (manager) {
    case "npm":
      return `npm install -g ${spec}`
    case "pnpm":
      return `pnpm add -g ${spec}`
    case "yarn":
      return `yarn global add ${spec}`
    case "bun":
      return `bun add -g ${spec}`
  }
}

export type InstallSource =
  | { kind: "managed"; manager: PackageManager }
  | { kind: "ambiguous" }
  | { kind: "self-managed"; reason: "dev-checkout" | "npx" | "desktop-sidecar" }

/**
 * Classify an install from the path of the running script.
 *
 * Path shape is the only signal available without spawning four package
 * managers, and it is a heuristic. `ambiguous` is a first-class answer.
 */
export function classifyInstall(scriptPath: string): InstallSource {
  const p = scriptPath.replace(/\\/g, "/").toLowerCase()
  if (p.includes("/_npx/") || p.includes("/.npm/_npx")) {
    return { kind: "self-managed", reason: "npx" }
  }
  if (p.includes("/cognia.app/") || p.includes("/resources/sidecar/")) {
    return { kind: "self-managed", reason: "desktop-sidecar" }
  }
  // A repo checkout: `cli/dist/...` next to a workspace, not a global prefix.
  if (p.includes("/cli/dist/") && !p.includes("/node_modules/")) {
    return { kind: "self-managed", reason: "dev-checkout" }
  }
  if (p.includes("/.bun/") || p.includes("/bun/install/"))
    return { kind: "managed", manager: "bun" }
  if (p.includes("/pnpm/") || p.includes("/.pnpm")) return { kind: "managed", manager: "pnpm" }
  if (p.includes("/.yarn/") || p.includes("/yarn/global")) {
    return { kind: "managed", manager: "yarn" }
  }
  if (p.includes("/lib/node_modules/") || p.includes("/node_modules/.bin/")) {
    return { kind: "managed", manager: "npm" }
  }
  return { kind: "ambiguous" }
}

export interface RegistryVersions {
  latest: string
  /** Versions published on the `beta` dist-tag, when one exists. */
  beta?: string
}

/** Ask the registry what is published. Never throws. */
export async function fetchPublishedVersions(
  registry = DEFAULT_REGISTRY,
  fetchImpl: typeof fetch = fetch
): Promise<RegistryVersions | null> {
  try {
    const response = await fetchImpl(`${registry}/${encodeURIComponent(CLI_PACKAGE)}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { "dist-tags"?: Record<string, string> }
    const latest = body["dist-tags"]?.latest
    if (typeof latest !== "string") return null
    return { latest, beta: body["dist-tags"]?.beta }
  } catch {
    return null
  }
}

interface CachedCheck {
  checkedAt: number
  latest: string
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000

function cachePath(): string {
  return join(process.env.COGNIA_HOME ?? join(homedir(), ".cognia"), "update-check.json")
}

/** Read the cached check. A missing or stale cache resolves to null. */
export async function readCachedCheck(
  now = Date.now(),
  read: typeof readFile = readFile
): Promise<CachedCheck | null> {
  try {
    const raw = await read(cachePath(), "utf8")
    const parsed = JSON.parse(String(raw)) as CachedCheck
    if (typeof parsed?.latest !== "string" || typeof parsed.checkedAt !== "number") return null
    if (now - parsed.checkedAt > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

/** Numeric semver compare tolerating a `v` prefix. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-", 1)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0)
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

export interface UpdateCommandDeps {
  out: OutputSink
  scriptPath?: string
  currentVersion?: string
  fetchVersions?: () => Promise<RegistryVersions | null>
  /** Run the delegated upgrade. Returns the child's exit code. */
  run?: (command: string) => Promise<number>
  /** Ask the user to confirm. Non-interactive sessions answer false. */
  confirm?: (question: string) => Promise<boolean>
}

function defaultRun(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" })
    child.on("close", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  process.stdout.write(`${question} [y/N] `)
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off("data", onData)
      process.stdin.pause()
      resolve(/^y/i.test(chunk.toString().trim()))
    }
    process.stdin.resume()
    process.stdin.once("data", onData)
  })
}

export async function updateCommand(args: ParsedArgs, deps: UpdateCommandDeps): Promise<number> {
  const out = deps.out
  const current = deps.currentVersion ?? VERSION
  const checkOnly = args.subcommand === "check"
  const json = args.flags.json === true
  const assumeYes = args.flags.yes === true

  const versions = await (deps.fetchVersions ?? (() => fetchPublishedVersions()))()
  if (!versions) {
    if (json) out.json({ ok: false, error: "registry_unreachable", current })
    else out.error("Could not reach the registry to check for a newer CLI.")
    return 1
  }

  const target = versions.latest
  const available = isNewer(target, current)

  if (!available) {
    if (json) out.json({ ok: true, current, latest: target, updateAvailable: false })
    else out.write(`cognia-agent ${current} is up to date.\n`)
    return 0
  }

  const source = classifyInstall(deps.scriptPath ?? process.argv[1] ?? "")

  if (json) {
    out.json({
      ok: true,
      current,
      latest: target,
      updateAvailable: true,
      source,
      commands:
        source.kind === "managed"
          ? [upgradeCommand(source.manager, target)]
          : source.kind === "ambiguous"
            ? PACKAGE_MANAGERS.map((m) => upgradeCommand(m, target))
            : [],
    })
    return 0
  }

  out.write(`cognia-agent ${current} to ${target} is available.\n`)

  if (source.kind === "self-managed") {
    const explanation = {
      npx: "This is a temporary npx run. Nothing is installed, so there is nothing to update.",
      "dev-checkout": "This is a development checkout. Update it with git and a rebuild.",
      "desktop-sidecar":
        "This CLI ships inside the Cognia desktop app. Update the app and it comes along.",
    }[source.reason]
    out.write(`${explanation}\n`)
    return 0
  }

  if (checkOnly) {
    const commands =
      source.kind === "managed"
        ? [upgradeCommand(source.manager, target)]
        : PACKAGE_MANAGERS.map((m) => upgradeCommand(m, target))
    out.write(`Run:\n${commands.map((c) => `  ${c}`).join("\n")}\n`)
    return 0
  }

  if (source.kind === "ambiguous") {
    out.write(
      "Cognia could not tell which package manager installed this CLI. Run the one you used:\n"
    )
    out.write(`${PACKAGE_MANAGERS.map((m) => `  ${upgradeCommand(m, target)}`).join("\n")}\n`)
    return 0
  }

  const command = upgradeCommand(source.manager, target)
  const confirmed =
    assumeYes || (await (deps.confirm ?? defaultConfirm)(`Run "${command}" to update?`))
  if (!confirmed) {
    out.write(`Skipped. Run it yourself with:\n  ${command}\n`)
    return 0
  }
  return (deps.run ?? defaultRun)(command)
}
