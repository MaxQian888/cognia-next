#!/usr/bin/env node

import { spawn } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { findListenerPids, freePort } from "./free-port.mjs"
import {
  DEFAULT_WORKSPACE_RUNTIME_PORT,
  ensureRuntimeSecret,
  runtimeDataDir,
  serverEnvironment,
} from "./workspace-runtime.mjs"

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

/**
 * Plaintext loopback listener for the browser (Rust
 * `browser_access::DEFAULT_BROWSER_PORT`, mirrored in
 * `lib/connectivity/loopback-discovery.ts`).
 *
 * `pnpm dev:headless` alone leaves it off, matching the production default.
 * This script exists precisely to put a browser tab and a headless Host on one
 * machine, and the tab cannot reach the HTTPS listener at all — it can neither
 * pin nor validate the self-signed certificate. So the one topology this script
 * is for is also the one that needs this port.
 */
const BROWSER_LISTENER_PORT = 27_891
/**
 * The remote browser's runtime (ADR-0085), run here as a third local service.
 *
 * A deployment gives every workspace its own runtime container and reaches it
 * by name; a laptop has neither the DNS nor the per-workspace secret files that
 * contract needs. So dev runs one runtime on loopback and points the Host at it
 * with `COGNIA_WORKSPACE_RUNTIME_URL` + a shared secret — the pair the Rust
 * locator accepts only for a loopback host. Without this service the browser
 * pane's remote engine is compiled and configured but has nothing to talk to.
 */
const WORKSPACE_RUNTIME_PORT = DEFAULT_WORKSPACE_RUNTIME_PORT
const requiredPorts = [3000, 27_890, BROWSER_LISTENER_PORT, WORKSPACE_RUNTIME_PORT]

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

/**
 * The only directory tree a paired client may browse and run in.
 *
 * The Host reads `COGNIA_WORKSPACES_DIR` once at startup and refuses every
 * path outside it, so leaving it unset confines the session to
 * `<data dir>/workspaces` -- a directory that holds none of the code you were
 * working on, which is why the folder picker used to open on a refusal. This
 * script exists to drive this machine's code from a browser tab, so the
 * default root is the checkout itself.
 *
 * The checkout, deliberately, and not the folder that contains it. That folder
 * is usually `~/Projects`, holding every other repository on the machine with
 * its own `.env` files and credentials, and the Host refuses nothing inside
 * the root it is given, for running as well as for browsing. Reaching a
 * sibling should be something you asked for, so it is `--workspaces-dir ..`
 * rather than the default. Widen, narrow or move it with that flag or with
 * `COGNIA_WORKSPACES_DIR`. Nothing outside the resolved root is reachable, and
 * no remote client can widen it.
 */
function requestedWorkspacesDir(argv = process.argv, env = process.env) {
  const flagIndex = argv.indexOf("--workspaces-dir")
  // A flag with no value is a mistake, not a request for the default. Left to
  // `argv[flagIndex + 1]` alone, `--workspaces-dir --dry-run` resolved
  // `<cwd>/--dry-run` as a path, and a trailing `--workspaces-dir` silently
  // fell through to the default, which is the opposite of narrowing.
  if (flagIndex !== -1) {
    const flagValue = (argv[flagIndex + 1] ?? "").trim()
    if (!flagValue || flagValue.startsWith("--")) {
      return { error: "--workspaces-dir needs a directory path" }
    }
    return { path: path.resolve(flagValue) }
  }
  const fromEnv = (env.COGNIA_WORKSPACES_DIR ?? "").trim()
  return { path: fromEnv ? path.resolve(fromEnv) : path.resolve(repoRoot) }
}

/**
 * Resolved through the real path, the way the Host resolves it, so the root
 * printed here is the root `fs_workspace_roots` reports back to the client.
 * A root that does not exist is refused now rather than at the first browse:
 * the Host would boot fine and then refuse every path with an opaque error.
 */
async function resolveWorkspacesDir(argv, env) {
  const requested = requestedWorkspacesDir(argv, env)
  if (requested.error) return { ok: false, message: requested.error }
  let resolved
  try {
    resolved = await realpath(requested.path)
  } catch {
    return { ok: false, message: `workspaces dir does not exist: ${requested.path}` }
  }
  if (!(await stat(resolved)).isDirectory()) {
    return { ok: false, message: `workspaces dir is not a directory: ${resolved}` }
  }
  return { ok: true, path: resolved }
}

function buildServices(workspacesDir) {
  return [
    { name: "web", command: pnpmCommand, args: ["dev"] },
    {
      name: "headless",
      command: pnpmCommand,
      args: [
        "dev:headless",
        "--browser-listener-port",
        String(BROWSER_LISTENER_PORT),
        "--workspaces-dir",
        workspacesDir,
      ],
    },
    { name: "workspace-runtime", command: pnpmCommand, args: ["dev:workspace-runtime"] },
  ]
}

async function findOccupiedPorts() {
  return (
    await Promise.all(
      requiredPorts.map(async (port) => ({ port, pids: await findListenerPids(port) }))
    )
  ).filter(({ pids }) => pids.length > 0)
}

function reportOccupiedPorts(occupiedPorts) {
  for (const { port, pids } of occupiedPorts) {
    process.stderr.write(
      `[dev:web-headless] port ${port} is already in use (pid ${pids.join(", ")}).\n`
    )
  }
}

async function waitForPortsToClear(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let occupiedPorts = await findOccupiedPorts()
  while (occupiedPorts.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    occupiedPorts = await findOccupiedPorts()
  }
  return occupiedPorts
}

function startServices(services, serviceEnvironments = {}) {
  const useProcessGroups = process.platform !== "win32"
  const children = services.map((service) => ({
    service,
    child: spawn(service.command, service.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(serviceEnvironments[service.name] ?? {}) },
      stdio: "inherit",
      detached: useProcessGroups,
    }),
  }))
  const exited = new Set()
  let shuttingDown = false
  let combinedExitCode = 0
  let forceTimer

  const signalChild = (child, signal) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    try {
      if (useProcessGroups) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }

  const finishWhenStopped = () => {
    if (exited.size !== children.length) return
    if (forceTimer) clearTimeout(forceTimer)
    process.exitCode = combinedExitCode
  }

  const shutdown = (exitCode, signal = "SIGTERM") => {
    if (shuttingDown) return
    shuttingDown = true
    combinedExitCode = exitCode
    for (const { child } of children) signalChild(child, signal)
    forceTimer = setTimeout(() => {
      for (const { child } of children) signalChild(child, "SIGKILL")
    }, 5_000)
    forceTimer.unref()
  }

  for (const { service, child } of children) {
    child.once("error", (error) => {
      process.stderr.write(`[dev:web-headless] ${service.name} failed to start: ${error.message}\n`)
      shutdown(1)
    })
    child.once("exit", (code, signal) => {
      exited.add(child)
      if (!shuttingDown) {
        const exitCode = typeof code === "number" ? code : 1
        const status = signal ? `signal ${signal}` : `exit code ${exitCode}`
        process.stderr.write(
          `[dev:web-headless] ${service.name} stopped (${status}); stopping peer.\n`
        )
        shutdown(exitCode)
      }
      finishWhenStopped()
    })
  }

  process.once("SIGINT", () => shutdown(130, "SIGINT"))
  process.once("SIGTERM", () => shutdown(143, "SIGTERM"))
}

const workspaces = await resolveWorkspacesDir()

if (!workspaces.ok) {
  process.stderr.write(`[dev:web-headless] ${workspaces.message}\n`)
  process.exitCode = 4
} else if (process.argv.includes("--dry-run")) {
  process.stdout.write(
    `${JSON.stringify({
      killPeerOnExit: true,
      workspacesDir: workspaces.path,
      services: buildServices(workspaces.path).map(({ name, args }) => ({
        name,
        command: "pnpm",
        args,
      })),
    })}\n`
  )
} else {
  const force = process.argv.includes("--force")
  const occupiedPorts = await findOccupiedPorts()
  if (occupiedPorts.length > 0 && !force) {
    reportOccupiedPorts(occupiedPorts)
    process.stderr.write(
      "[dev:web-headless] Stop those processes or rerun with --force to terminate the exact listeners.\n"
    )
    process.exitCode = 2
  } else {
    if (occupiedPorts.length > 0) {
      for (const { port } of occupiedPorts) {
        const { killed } = await freePort(port, { log: () => {} })
        if (killed.length > 0) {
          process.stdout.write(
            `[dev:web-headless] force-killed listener(s) on port ${port} (pid ${killed.join(", ")}).\n`
          )
        }
      }
    }
    const remainingPorts = await waitForPortsToClear()
    if (remainingPorts.length > 0) {
      reportOccupiedPorts(remainingPorts)
      process.stderr.write("[dev:web-headless] Failed to release every required port.\n")
      process.exitCode = 3
    } else {
      // Generated once, on disk, in the headless data dir: the runtime service
      // resolves the same file for itself, so the two processes share a secret
      // without either one having to be started first.
      const secret = await ensureRuntimeSecret(runtimeDataDir())
      // Say the confinement out loud. It is the difference between a folder
      // picker that opens on your projects and one that opens on a refusal,
      // and it is fixed for the life of the process.
      process.stdout.write(
        `[dev:web-headless] paired clients may browse and run in ${workspaces.path} (override with --workspaces-dir PATH).\n`
      )
      startServices(buildServices(workspaces.path), {
        headless: serverEnvironment({ secret, port: WORKSPACE_RUNTIME_PORT }),
      })
    }
  }
}
