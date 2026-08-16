#!/usr/bin/env node

import { spawn } from "node:child_process"

import { findListenerPids, freePort } from "./free-port.mjs"

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const requiredPorts = [3000, 27_890]
const services = [
  { name: "web", command: pnpmCommand, args: ["dev"] },
  { name: "headless", command: pnpmCommand, args: ["dev:headless"] },
]

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

function startServices() {
  const useProcessGroups = process.platform !== "win32"
  const children = services.map((service) => ({
    service,
    child: spawn(service.command, service.args, {
      cwd: process.cwd(),
      env: process.env,
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

if (process.argv.includes("--dry-run")) {
  process.stdout.write(
    `${JSON.stringify({
      killPeerOnExit: true,
      services: services.map(({ name, args }) => ({ name, command: "pnpm", args })),
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
      startServices()
    }
  }
}
