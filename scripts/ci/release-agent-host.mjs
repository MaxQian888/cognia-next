// Same-run release handoff; dependency caches never stand in for a verified host.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  hashFile,
  listPackagedFiles,
  verifyAgentHostPackage,
} from "../build/verify-agent-host-package.mjs"
import { nativeHostFiles } from "../build/native-host-files.mjs"
import { createGitHubClient } from "./feishu/github.mjs"

const target = `${process.platform}-${process.arch}`
const packagePath = `packages/agent-host-${target}`
const artifactPath = ".cache/release-agent-host"
const run = (root, command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

function identity(root, env) {
  const head = run(root, "git", ["rev-parse", "HEAD"])
  if (
    head !== env.GITHUB_SHA ||
    !/^[a-f0-9]{40}$/.test(head) ||
    !/^[\w-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
  ) {
    throw new Error("Invalid release host checkout/run identity")
  }
  return {
    version: 1,
    head,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    target,
    packageJson: hashFile(path.join(root, packagePath, "package.json")),
  }
}

function snapshot(packageRoot) {
  return Object.fromEntries(
    [
      "integrity.json",
      ...listPackagedFiles(path.join(packageRoot, "bin")).map((file) => `bin/${file}`),
    ]
      .sort()
      .map((file) => {
        const absolute = path.join(packageRoot, file)
        const stat = fs.lstatSync(absolute)
        if (!stat.isFile()) throw new Error(`Release host payload must be a regular file: ${file}`)
        return [file, { ...hashFile(absolute), mode: stat.mode & 0o777 }]
      })
  )
}

export function prepareReleaseHost(root, env = process.env) {
  const expected = identity(root, env)
  run(root, "git", ["diff", "--quiet", "HEAD", "--"])
  verifyAgentHostPackage(root, target)
  const packageRoot = path.join(root, packagePath)
  const files = snapshot(packageRoot)
  const directory = path.join(root, artifactPath)
  fs.mkdirSync(directory, { recursive: true })
  const archive = path.join(directory, "host.tar.gz")
  run(root, "tar", ["-czf", archive, "-C", packageRoot, "bin", "integrity.json"])
  if (
    JSON.stringify(snapshot(packageRoot)) !== JSON.stringify(files) ||
    JSON.stringify(identity(root, env)) !== JSON.stringify(expected)
  ) {
    throw new Error("Release host changed during archiving")
  }
  run(root, "git", ["diff", "--quiet", "HEAD", "--"])
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      {
        ...expected,
        attempt: Number(env.GITHUB_RUN_ATTEMPT),
        files,
        archive: hashFile(archive),
      },
      null,
      2
    ) + "\n"
  )
}

export function restoreReleaseHost(root, env = process.env) {
  const directory = path.join(root, artifactPath)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"))
  for (const [key, value] of Object.entries(identity(root, env))) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value))
      throw new Error(`Release host ${key} identity mismatch`)
  }
  // A successful producer from an earlier attempt remains usable when only the
  // failed SDK job is rerun; it must still belong to this run and exact SHA.
  if (
    !Number.isSafeInteger(manifest.attempt) ||
    manifest.attempt < 1 ||
    manifest.attempt > Number(env.GITHUB_RUN_ATTEMPT)
  ) {
    throw new Error("Invalid release host producer attempt")
  }
  const archive = path.join(directory, "host.tar.gz")
  if (JSON.stringify(hashFile(archive)) !== JSON.stringify(manifest.archive))
    throw new Error("Release host archive digest mismatch")
  const entries = run(root, "tar", ["-tzf", archive]).split("\n")
  if (
    entries.some(
      (entry) =>
        !/^(?:bin(?:\/[^\n]*)?|integrity\.json)$/.test(entry) ||
        entry.split("/").some((part) => part === ".." || part === ".")
    )
  ) {
    throw new Error("Invalid release host archive path")
  }
  const temporary = fs.mkdtempSync(path.join(directory, "restore-"))
  try {
    const packageRoot = path.join(temporary, packagePath)
    fs.mkdirSync(packageRoot, { recursive: true })
    fs.copyFileSync(
      path.join(root, packagePath, "package.json"),
      path.join(packageRoot, "package.json")
    )
    run(root, "tar", ["-xzf", archive, "-C", packageRoot])
    verifyAgentHostPackage(temporary, target)
    if (JSON.stringify(snapshot(packageRoot)) !== JSON.stringify(manifest.files))
      throw new Error("Release host payload digest, closure or mode mismatch")
    for (const file of ["bin", "integrity.json"]) {
      const destination = path.join(root, packagePath, file)
      fs.rmSync(destination, { recursive: true, force: true })
      fs.renameSync(path.join(packageRoot, file), destination)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export function releaseHostEnvironment(root) {
  verifyAgentHostPackage(root, target)
  return Object.fromEntries(
    nativeHostFiles(root, { suffix: process.platform === "win32" ? ".exe" : "", env: {} }).map(
      (helper) => [helper.overrideEnv, path.join(root, packagePath, "bin", helper.name)]
    )
  )
}

export async function selectReleaseHost(root, env = process.env, client) {
  const expected = identity(root, env)
  const name = `release-agent-host-${target}-${expected.head}`
  const github =
    client ??
    createGitHubClient({
      repository: expected.repository,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL,
    })
  const artifacts = await github.listArtifacts({ runId: expected.runId, name })
  const selected = artifacts.filter((artifact) => artifact.name === name && !artifact.expired)
  if (selected.length > 1) throw new Error("Found multiple release host artifacts")
  const artifact = selected[0]
  if (!artifact) return ""
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    String(artifact.workflow_run?.id) !== expected.runId ||
    artifact.workflow_run?.head_sha !== expected.head
  ) {
    throw new Error("Release host artifact identity mismatch")
  }
  return String(artifact.id)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error("Unexpected release host arguments")
  const root = process.cwd()
  if (command === "prepare") prepareReleaseHost(root)
  else if (command === "restore") restoreReleaseHost(root)
  else if (command === "select") {
    const id = await selectReleaseHost(root)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `id=${id}\n`)
    console.log(
      id
        ? `Release host artifact selected: ${id}`
        : "Release host artifact absent; a complete build is required"
    )
  } else if (command === "env") {
    const overrides = releaseHostEnvironment(root)
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      Object.entries(overrides)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    )
    console.log("Verified packaged native helpers for the Node RPC smoke build")
  } else throw new Error("Usage: release-agent-host.mjs prepare | select | restore | env")
}
