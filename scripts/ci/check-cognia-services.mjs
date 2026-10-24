#!/usr/bin/env node
/**
 * The app consumes cognia-labs/cognia-services at ONE pinned revision
 * (`integrations/cognia-services.json`): the `cognia-signaling-core` Cargo
 * dependency and the `@cognia/sync-protocol` / `@cognia/status-contract`
 * packages. This check keeps every spelling of that revision equal and, given
 * a checkout of the pinned revision, verifies the contract copies the app
 * keeps beside its own code.
 *
 *   node scripts/ci/check-cognia-services.mjs
 *       pin consistency only (Cargo.toml, package.json, cli/package.json and
 *       both lockfiles)
 *   node scripts/ci/check-cognia-services.mjs --services-root <dir>
 *       also: the checkout is the pinned revision and every vendored
 *       contract copy matches it
 *   node scripts/ci/check-cognia-services.mjs --fetch [<dir>]
 *       clone the pinned revision into <dir> (default .cache/cognia-services)
 *       for local runs of the checks and suites that read service sources
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PIN_FILE = "integrations/cognia-services.json"
export const SERVICES_REPOSITORY = "cognia-labs/cognia-services"
export const DEFAULT_SERVICES_ROOT = ".cache/cognia-services"

const GIT_URL = `https://github.com/${SERVICES_REPOSITORY}`

/** Contract files the app keeps a byte-identical copy of: [app path, services path]. */
export const VENDORED_COPIES = [
  [
    "crates/cognia-tenant-auth/fixtures/grant-wire-vector.json",
    "services/share-server/fixtures/grant-wire-vector.json",
  ],
  ["protocol/cognia-services/diagnostic-openapi.yaml", "services/diagnostic-server/openapi.yaml"],
  ["protocol/cognia-services/share-constants.json", "services/share-server/share-constants.json"],
]

/** JSON fixtures whose `vectors` both sides must list identically: [app path, services path]. */
export const SHARED_VECTORS = [
  [
    "lib/plugin/character-pack/__fixtures__/jcs-vectors.json",
    "packages/sync-protocol/fixtures/jcs-vectors.json",
  ],
]

/** Every package the app installs from the services repository, by manifest. */
export const PACKAGE_REFERENCES = {
  "package.json": ["@cognia/status-contract", "@cognia/sync-protocol"],
  "cli/package.json": ["@cognia/sync-protocol"],
}

const PACKAGE_DIRECTORIES = {
  "@cognia/status-contract": "/packages/status-contract",
  "@cognia/sync-protocol": "/packages/sync-protocol",
}

export async function readPin(root) {
  const pin = JSON.parse(await readFile(resolve(root, PIN_FILE), "utf8"))
  if (pin.repository !== SERVICES_REPOSITORY || !/^[a-f0-9]{40}$/.test(pin.revision ?? ""))
    throw new Error(`${PIN_FILE} must name ${SERVICES_REPOSITORY} and a 40-hex revision`)
  return pin
}

/** Returns the human-readable list of problems; empty when every spelling agrees. */
export async function pinProblems(root) {
  const { revision } = await readPin(root)
  const problems = []

  const cargo = await readFile(resolve(root, "Cargo.toml"), "utf8")
  const dependency = /^cognia-signaling-core\s*=\s*\{([^}]*)\}/m.exec(cargo)?.[1] ?? ""
  if (!dependency.includes(`git = "${GIT_URL}"`) || !dependency.includes(`rev = "${revision}"`))
    problems.push(
      `Cargo.toml [workspace.dependencies] cognia-signaling-core must be { git = "${GIT_URL}", rev = "${revision}" }`
    )

  for (const [manifest, names] of Object.entries(PACKAGE_REFERENCES)) {
    const pkg = JSON.parse(await readFile(resolve(root, manifest), "utf8"))
    const declared = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const name of names) {
      const expected = `git+${GIT_URL}.git#${revision}&path:${PACKAGE_DIRECTORIES[name]}`
      if (declared[name] !== expected)
        problems.push(
          `${manifest} ${name} must be "${expected}", found ${JSON.stringify(declared[name])}`
        )
    }
  }

  // Every lockfile mention of the repository must carry the pinned revision:
  // a lock left behind by a pin bump installs the old contract silently.
  for (const lockfile of ["Cargo.lock", "pnpm-lock.yaml"]) {
    const lines = (await readFile(resolve(root, lockfile), "utf8")).split("\n")
    const mentions = lines.filter((line) => line.includes("cognia-labs/cognia-services"))
    if (mentions.length === 0) problems.push(`${lockfile} does not resolve ${SERVICES_REPOSITORY}`)
    for (const line of mentions)
      if (!line.includes(revision))
        problems.push(`${lockfile} resolves a different revision: ${line.trim()}`)
  }
  return problems
}

function servicesHead(servicesRoot) {
  return execFileSync("git", ["-C", servicesRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
}

/** Returns the list of contract drifts between the app and a pinned checkout. */
export async function contractProblems(root, servicesRoot, head = servicesHead) {
  const { revision } = await readPin(root)
  const problems = []
  const checkedOut = head(servicesRoot)
  if (checkedOut !== revision)
    problems.push(`${servicesRoot} is at ${checkedOut}, not the pinned ${revision}`)

  for (const [appPath, servicesPath] of VENDORED_COPIES) {
    const [ours, theirs] = await Promise.all([
      readFile(resolve(root, appPath)),
      readFile(resolve(servicesRoot, servicesPath)),
    ])
    if (!ours.equals(theirs))
      problems.push(
        `${appPath} differs from ${servicesPath} at the pinned revision; change the contract in cognia-services first, then copy it here with the pin bump`
      )
  }

  for (const [appPath, servicesPath] of SHARED_VECTORS) {
    const [ours, theirs] = await Promise.all([
      readFile(resolve(root, appPath), "utf8").then(JSON.parse),
      readFile(resolve(servicesRoot, servicesPath), "utf8").then(JSON.parse),
    ])
    if (JSON.stringify(ours.vectors) !== JSON.stringify(theirs.vectors))
      problems.push(`${appPath} and ${servicesPath} list different vectors`)
  }
  return problems
}

export function fetchPinned(revision, directory) {
  mkdirSync(directory, { recursive: true })
  if (!existsSync(resolve(directory, ".git"))) {
    execFileSync("git", ["init", "--quiet", directory])
    execFileSync("git", ["-C", directory, "remote", "add", "origin", `${GIT_URL}.git`])
  }
  execFileSync("git", ["-C", directory, "fetch", "--quiet", "--depth=1", "origin", revision], {
    stdio: "inherit",
  })
  execFileSync("git", ["-C", directory, "checkout", "--quiet", "--detach", revision], {
    stdio: "inherit",
  })
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value && !value.startsWith("--") ? value : null
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd()
  const argv = process.argv.slice(2)
  if (argv.includes("--fetch")) {
    const directory = resolve(root, argValue(argv, "--fetch") ?? DEFAULT_SERVICES_ROOT)
    const { revision } = await readPin(root)
    fetchPinned(revision, directory)
    console.log(`${SERVICES_REPOSITORY}@${revision} checked out at ${directory}`)
    process.exit(0)
  }
  const problems = await pinProblems(root)
  const servicesRoot = argValue(argv, "--services-root")
  if (servicesRoot === null) problems.push("--services-root needs a directory")
  else if (servicesRoot)
    problems.push(...(await contractProblems(root, resolve(root, servicesRoot))))
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`)
    process.exit(1)
  }
  console.log(
    servicesRoot
      ? `cognia-services pin and ${VENDORED_COPIES.length + SHARED_VECTORS.length} contract copies verified`
      : "cognia-services pin is consistent"
  )
}
