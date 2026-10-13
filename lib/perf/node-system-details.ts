/**
 * System details for a Node/headless Host (the brain's `perf_system_details`).
 *
 * In a container the process sees the Host's kernel, processors and memory,
 * but its own `/etc/os-release` and a random hostname. The os-release(5)
 * convention for that is `/run/host/os-release`: a container that is handed
 * the Host's file there reports the Host's distribution. The compose stack
 * mounts it, and the Host's `/etc/hostname` beside it, when
 * `COGNIA_HOST_OS_RELEASE` / `COGNIA_HOST_HOSTNAME_FILE` point at them
 * (`deploy/compose/docker-compose.yml`); outside a container the process's
 * own files are the Host's.
 *
 * Node-only: imported lazily from `lib/perf/host-dispatch`.
 */

import type { SystemDetails } from "./backend/types"

/** Where a container finds the Host's files, then its own. */
export const OS_RELEASE_PATHS = ["/run/host/os-release", "/etc/os-release"] as const
export const HOST_HOSTNAME_PATH = "/run/host/hostname"

export interface NodeSystemDetailsDeps {
  os: Pick<
    typeof import("node:os"),
    "platform" | "release" | "version" | "arch" | "hostname" | "cpus" | "totalmem" | "freemem"
  >
  /** Reads a small text file; rejects when it is missing or unreadable. */
  readText: (path: string) => Promise<string>
  env: Record<string, string | undefined>
}

/** A distribution as `perf_system_details` names one: `os` and `osVersion`. */
export interface OsRelease {
  name: string
  version: string | null
}

/**
 * The distribution an os-release file names: `NAME` with `VERSION` (else
 * `VERSION_ID`), the same split the Rust host reports, or `PRETTY_NAME` alone.
 */
export function parseOsRelease(osRelease: string): OsRelease | null {
  const fields = new Map<string, string>()
  for (const line of osRelease.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    fields.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2").trim())
  }
  const name = fields.get("NAME")
  if (name) return { name, version: fields.get("VERSION") || fields.get("VERSION_ID") || null }
  const pretty = fields.get("PRETTY_NAME")
  return pretty ? { name: pretty, version: null } : null
}

async function firstReadable<T>(
  readText: NodeSystemDetailsDeps["readText"],
  paths: readonly string[],
  parse: (text: string) => T | null
): Promise<T | null> {
  for (const path of paths) {
    try {
      const value = parse(await readText(path))
      if (value) return value
    } catch {
      // Missing, a directory, or unreadable: try the next one.
    }
  }
  return null
}

export async function gatherNodeSystemDetails(deps: NodeSystemDetailsDeps): Promise<SystemDetails> {
  const { os } = deps
  const cpus = os.cpus()
  const [distribution, hostname] = await Promise.all([
    firstReadable(deps.readText, OS_RELEASE_PATHS, parseOsRelease),
    firstReadable(deps.readText, [HOST_HOSTNAME_PATH], (text) => text.trim() || null),
  ])
  return {
    // The distribution where one is known; the platform id otherwise.
    os: distribution?.name ?? os.platform(),
    osVersion: distribution?.version ?? null,
    kernelVersion: os.release(),
    arch: os.arch(),
    family: "node",
    hostname: hostname ?? os.hostname(),
    cpu: cpus.at(0)?.model?.trim() || null,
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    usedMemoryBytes: os.totalmem() - os.freemem(),
    appVersion: deps.env.npm_package_version ?? "unknown",
    tauriVersion: "unsupported",
    profile: deps.env.NODE_ENV ?? "development",
    enabledFeatures: ["node-headless", "performance.observe"],
  }
}

/** This process's details, from Node's own modules. */
export async function nodeSystemDetails(): Promise<SystemDetails> {
  // static-export-exempt: Node-host only, lazy import
  const [os, fs] = await Promise.all([import("node:os"), import("node:fs/promises")])
  return gatherNodeSystemDetails({
    os,
    readText: (path) => fs.readFile(path, "utf8"),
    env: process.env,
  })
}
