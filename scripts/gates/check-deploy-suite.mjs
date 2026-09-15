#!/usr/bin/env node
/**
 * Gate: the container/deploy suite stays coherent with the repository's pins
 * and stays safe to run more than once per host.
 *
 * Why it exists: every finding below shipped green. Nothing tied a
 * Dockerfile's base image to `rust-toolchain.toml` or `engines.node`, nothing
 * tied a compose default image to the workflow that publishes it, and
 * nothing said that two compose instances on one host must not collide.
 *
 *   - `Dockerfile.deploy-agent` / `Dockerfile.ops-controller` built on
 *     rust:1.89 while the shared Cargo.lock was resolved for the 1.95 pin.
 *   - `deploy/compose/Dockerfile.web` built the export on node:22 against an
 *     `engines.node >= 26` workspace, and the compose-e2e lane installed with
 *     pnpm 10 against a pnpm 11 lockfile.
 *   - The compose `tls` profile and the production override pulled
 *     `ghcr.io/<owner>/cognia-web`, which no workflow ever published.
 *   - Every host port was a literal and the T2 workspaces volume had a fixed
 *     name, so a second instance on the same host either failed to bind or
 *     silently shared the first instance's agent workspaces.
 *
 * What is checked (all static, all against checked-in text):
 *   1. Every root-context Rust Dockerfile builds on the `rust-toolchain.toml`
 *      channel (they run `--locked` against the shared Cargo.lock).
 *   2. Every Dockerfile that installs the root workspace uses a Node major
 *      that satisfies `engines.node` and pins the `packageManager` pnpm.
 *   3. Every `ghcr.io/<owner>/<name>` a compose file defaults to is published
 *      by `images.yml`.
 *   4. Every published host port in `docker-compose.yml` is interpolated, so
 *      an instance can remap it without editing the file.
 *   5. The compose project name, the runner ownership label
 *      (`COGNIA_DEPLOYMENT_ID`) and the T2 workspaces volume all derive from
 *      `COGNIA_INSTANCE`, and the volume name matches the env var the server
 *      reads byte for byte.
 *   6. No GitHub workflow pins a pnpm version other than `packageManager`.
 *
 * What is NOT checked, and why: that the images build, that compose brings
 * the stack up, or that two instances actually coexist. Those are runtime
 * properties of a daemon and belong to `compose-e2e.yml` and the smoke.
 *
 * Usage: pnpm audit:deploy-suite
 */

import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { parse as parseYaml } from "yaml"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/** Dockerfiles whose build context is the repo root and whose `cargo build --locked` resolves the shared Cargo.lock. */
export const ROOT_CONTEXT_RUST_DOCKERFILES = [
  "Dockerfile.cognia-server",
  "Dockerfile.collab-server",
  "Dockerfile.deploy-agent",
  "Dockerfile.ops-controller",
  // ADR-0183: builds the static cognia-sandboxd from the workspace.
  "deploy/bundle/Dockerfile",
]

/** Dockerfiles that run `pnpm install` against the root workspace. */
export const ROOT_WORKSPACE_NODE_DOCKERFILES = [
  "Dockerfile.cognia-server",
  "deploy/compose/Dockerfile.web",
  "services/workspace-runtime/Dockerfile",
]

export const COMPOSE_BASE = "deploy/compose/docker-compose.yml"
export const COMPOSE_T2 = "deploy/compose/docker-compose.t2.yml"
/** Compose files whose default images must be published. The CI-only e2e overlay reuses the same images. */
export const COMPOSE_FILES_WITH_IMAGES = [COMPOSE_BASE, COMPOSE_T2]
export const IMAGES_WORKFLOW = ".github/workflows/images.yml"
export const WORKFLOWS_DIR = ".github/workflows"
export const INSTANCE_VAR = "COGNIA_INSTANCE"

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8")

/** `1.95` from a rust-toolchain.toml. */
export function toolchainChannel(toolchainToml) {
  const match = toolchainToml.match(/^\s*channel\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error("rust-toolchain.toml has no channel")
  return match[1]
}

/** Every `FROM <image>` line's image reference, in order. */
export function fromImages(dockerfile) {
  return [...dockerfile.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map((m) => m[1])
}

export function checkRustBases({ dockerfiles, channel }) {
  const problems = []
  for (const [rel, text] of Object.entries(dockerfiles)) {
    for (const image of fromImages(text)) {
      const match = image.match(/^rust:(\d+\.\d+)(?:\.\d+)?(?:-|$)/)
      if (!match) continue
      if (match[1] !== channel) {
        problems.push(
          `${rel}: builds on ${image} but rust-toolchain.toml pins ${channel}. The build runs \`cargo build --locked\` against the shared Cargo.lock, whose floor is the workspace channel, not the crate's own rust-version.`
        )
      }
    }
  }
  return problems
}

/** Minimum Node major from an `engines.node` range such as ">=26.0.0". */
export function minimumNodeMajor(enginesNode) {
  const match = String(enginesNode ?? "").match(/(\d+)/)
  if (!match) throw new Error(`cannot read a Node major from engines.node ${enginesNode}`)
  return Number(match[1])
}

/** "11.18.0" from "pnpm@11.18.0". */
export function pinnedPnpmVersion(packageManager) {
  const match = String(packageManager ?? "").match(/^pnpm@(\S+)$/)
  if (!match) throw new Error(`packageManager ${packageManager} is not a pnpm pin`)
  return match[1]
}

export function checkNodeBases({ dockerfiles, enginesNode, packageManager }) {
  const problems = []
  const minMajor = minimumNodeMajor(enginesNode)
  const pnpm = pinnedPnpmVersion(packageManager)
  for (const [rel, text] of Object.entries(dockerfiles)) {
    for (const image of fromImages(text)) {
      const match = image.match(/^node:(\d+)/)
      if (!match) continue
      if (Number(match[1]) < minMajor) {
        problems.push(
          `${rel}: builds on ${image} but package.json requires engines.node ${enginesNode}. The install and the build run under a Node the workspace does not support.`
        )
      }
    }
    const pins = [...text.matchAll(/^\s*ARG\s+PNPM_VERSION=(\S+)/gm)].map((m) => m[1])
    if (pins.length === 0) {
      problems.push(
        `${rel}: does not declare ARG PNPM_VERSION. The image must install the packageManager pnpm (${pnpm}) explicitly; a floating Corepack resolves whatever the base image ships.`
      )
    }
    for (const pin of pins) {
      if (pin !== pnpm) {
        problems.push(
          `${rel}: ARG PNPM_VERSION=${pin} but package.json packageManager is pnpm@${pnpm}. A different pnpm cannot be trusted with --frozen-lockfile on this lockfile.`
        )
      }
    }
  }
  return problems
}

/** The literal default of a compose value: `${VAR:-x}` → x, `${VAR-x}` → x, plain → plain. */
export function composeDefault(value) {
  if (typeof value !== "string") return undefined
  const match = value.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:?-(.*)\}$/)
  return match ? match[1] : value
}

/** `cognia-web` from `ghcr.io/owner/cognia-web:latest` or `@sha256:...`. */
export function ghcrImageName(reference) {
  const match = String(reference ?? "").match(/^ghcr\.io\/[^/]+\/([a-z0-9._-]+)(?:[:@].*)?$/)
  return match ? match[1] : undefined
}

/** Every image name `images.yml` builds: matrix entries plus the `images:` metadata inputs. */
export function publishedImageNames(imagesWorkflowText) {
  const names = new Set()
  const workflow = parseYaml(imagesWorkflowText)
  for (const job of Object.values(workflow?.jobs ?? {})) {
    for (const entry of job?.strategy?.matrix?.include ?? []) {
      if (typeof entry?.name === "string") names.add(entry.name)
    }
  }
  for (const [, name] of imagesWorkflowText.matchAll(
    /ghcr\.io\/\$\{\{[^}]+\}\}\/([a-z0-9._-]+)/g
  )) {
    names.add(name)
  }
  return names
}

export function checkComposeImagesPublished({ composeFiles, imagesWorkflow }) {
  const problems = []
  const published = publishedImageNames(imagesWorkflow)
  for (const [rel, text] of Object.entries(composeFiles)) {
    const compose = parseYaml(text)
    for (const [service, spec] of Object.entries(compose?.services ?? {})) {
      const name = ghcrImageName(composeDefault(spec?.image))
      if (!name) continue
      if (!published.has(name)) {
        problems.push(
          `${rel}: service "${service}" defaults to ghcr.io/…/${name}, which no job in ${IMAGES_WORKFLOW} publishes. The profile that needs it can never be satisfied from the registry.`
        )
      }
    }
  }
  return problems
}

/** Host side of a short-syntax port mapping: everything before the container port. */
export function hostPortSide(mapping) {
  const text = String(mapping)
  const withoutProtocol = text.replace(/\/(tcp|udp)$/i, "")
  const lastColon = withoutProtocol.lastIndexOf(":")
  return lastColon === -1 ? "" : withoutProtocol.slice(0, lastColon)
}

export function checkComposePortsParametrized({ composeText, rel = COMPOSE_BASE }) {
  const problems = []
  const compose = parseYaml(composeText)
  for (const [service, spec] of Object.entries(compose?.services ?? {})) {
    for (const mapping of spec?.ports ?? []) {
      if (typeof mapping !== "string") {
        problems.push(
          `${rel}: service "${service}" publishes a port in long syntax. Use the short "\${VAR:-host}:container" form so the gate can see the host side.`
        )
        continue
      }
      const host = hostPortSide(mapping)
      if (!host.includes("${")) {
        problems.push(
          `${rel}: service "${service}" publishes "${mapping}" with a literal host port. A second instance on the same host cannot remap it without editing the file.`
        )
      }
    }
  }
  return problems
}

export function checkInstanceScoping({ baseText, t2Text }) {
  const problems = []
  const base = parseYaml(baseText)
  const t2 = parseYaml(t2Text)
  const instanceRef = `\${${INSTANCE_VAR}`

  if (!String(base?.name ?? "").includes(instanceRef)) {
    problems.push(
      `${COMPOSE_BASE}: top-level "name" does not derive from ${INSTANCE_VAR}. Two instances would share one compose project, so volumes, networks and container names collide.`
    )
  }

  const deployment = base?.services?.["cognia-server"]?.environment?.COGNIA_DEPLOYMENT_ID
  if (!String(deployment ?? "").includes(instanceRef)) {
    problems.push(
      `${COMPOSE_BASE}: cognia-server does not set COGNIA_DEPLOYMENT_ID from ${INSTANCE_VAR}. The boot-time orphan sweep scopes on it; without it two servers sharing a Docker daemon reap each other's live runners.`
    )
  }

  const volume = t2?.volumes?.cognia_workspaces?.name
  const envVolume = t2?.services?.["cognia-server"]?.environment?.COGNIA_WORKSPACES_VOLUME
  if (!String(volume ?? "").includes(instanceRef)) {
    problems.push(
      `${COMPOSE_T2}: the cognia_workspaces volume name does not derive from ${INSTANCE_VAR}. A second instance would mount the first instance's agent workspaces.`
    )
  }
  if (volume !== envVolume) {
    problems.push(
      `${COMPOSE_T2}: volumes.cognia_workspaces.name (${volume}) must equal cognia-server's COGNIA_WORKSPACES_VOLUME (${envVolume}). The backend mounts runner workspaces by that exact volume name.`
    )
  }
  return problems
}

export function checkWorkflowPnpmPins({ workflows, packageManager }) {
  const problems = []
  const pnpm = pinnedPnpmVersion(packageManager)
  for (const [rel, text] of Object.entries(workflows)) {
    const workflow = parseYaml(text)
    for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (!String(step?.uses ?? "").startsWith("pnpm/action-setup")) continue
        const version = step?.with?.version
        if (version === undefined) continue
        if (String(version) !== pnpm) {
          problems.push(
            `${rel}: job "${jobName}" pins pnpm ${version} but package.json packageManager is pnpm@${pnpm}. Omit the version so action-setup reads the pin, or match it.`
          )
        }
      }
    }
  }
  return problems
}

export function runChecks(inputs) {
  return [
    ...checkRustBases({ dockerfiles: inputs.rustDockerfiles, channel: inputs.channel }),
    ...checkNodeBases({
      dockerfiles: inputs.nodeDockerfiles,
      enginesNode: inputs.enginesNode,
      packageManager: inputs.packageManager,
    }),
    ...checkComposeImagesPublished({
      composeFiles: inputs.composeFiles,
      imagesWorkflow: inputs.imagesWorkflow,
    }),
    ...checkComposePortsParametrized({ composeText: inputs.composeFiles[COMPOSE_BASE] }),
    ...checkInstanceScoping({
      baseText: inputs.composeFiles[COMPOSE_BASE],
      t2Text: inputs.composeFiles[COMPOSE_T2],
    }),
    ...checkWorkflowPnpmPins({
      workflows: inputs.workflows,
      packageManager: inputs.packageManager,
    }),
  ]
}

export function loadRepoInputs() {
  const pkg = JSON.parse(read("package.json"))
  const workflowFiles = readdirSync(join(REPO_ROOT, WORKFLOWS_DIR)).filter((f) =>
    /\.ya?ml$/.test(f)
  )
  return {
    channel: toolchainChannel(read("rust-toolchain.toml")),
    enginesNode: pkg.engines?.node,
    packageManager: pkg.packageManager,
    rustDockerfiles: Object.fromEntries(
      ROOT_CONTEXT_RUST_DOCKERFILES.map((rel) => [rel, read(rel)])
    ),
    nodeDockerfiles: Object.fromEntries(
      ROOT_WORKSPACE_NODE_DOCKERFILES.map((rel) => [rel, read(rel)])
    ),
    composeFiles: Object.fromEntries(COMPOSE_FILES_WITH_IMAGES.map((rel) => [rel, read(rel)])),
    imagesWorkflow: read(IMAGES_WORKFLOW),
    workflows: Object.fromEntries(
      workflowFiles.map((f) => [`${WORKFLOWS_DIR}/${f}`, read(`${WORKFLOWS_DIR}/${f}`)])
    ),
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const problems = runChecks(loadRepoInputs())
  if (problems.length > 0) {
    console.error("deploy-suite: the container/deploy suite has drifted\n")
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    console.error(`\n${problems.length} problem(s).`)
    process.exit(1)
  }
  console.log(
    `deploy-suite: OK — ${ROOT_CONTEXT_RUST_DOCKERFILES.length} Rust images on the toolchain pin, ${ROOT_WORKSPACE_NODE_DOCKERFILES.length} Node images on engines/packageManager, every compose default image published, host ports and instance scoping parametrized, workflow pnpm pins aligned.`
  )
}
