#!/usr/bin/env node
// ADR-0228: record the image actually published by the existing Images workflow.
// This script never builds, resolves tags, pushes an image or contacts E2B.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const IMAGE_CONTEXT = "crates/cognia-automation/src/cua_sandbox/image"

export const RELEASE_IDENTITY = Object.freeze({
  architecture: "linux/amd64",
  recipeRevision: "4",
  protocol: "computer-server-0.3.46",
  serverVersion: "0.3.46",
  // Template snapshots must never contain a runtime guest token. The Host
  // starts the authenticated desktop over protected envd after create.
  startCommand: "sleep infinity",
  readyCommand:
    "test -x /usr/local/bin/cognia-desktop && test -f /opt/cognia-desktop/server.py && test -f /opt/cognia-desktop/startup.py && test -x /usr/bin/git && test -x /usr/bin/node && test -x /usr/bin/npm && test -x /usr/bin/bwrap && test -x /usr/local/bin/cognia-desktop-guest",
})

export function createManagedDesktopRelease({ imageRepository, digest }) {
  if (
    typeof imageRepository !== "string" ||
    !/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/cognia-managed-desktop$/.test(imageRepository)
  ) {
    throw new Error("Expected an untagged ghcr.io/<owner>/cognia-managed-desktop repository")
  }
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("A complete sha256 digest from the published image build is required")
  }
  return {
    image: `${imageRepository}@${digest}`,
    imageDigest: digest,
    ...RELEASE_IDENTITY,
  }
}

export function verifyImageSources(root = ROOT) {
  const dockerfile = readFileSync(resolve(root, IMAGE_CONTEXT, "Dockerfile"), "utf8")
  const server = readFileSync(resolve(root, IMAGE_CONTEXT, "server.py"), "utf8")
  if (!/^FROM \S+@sha256:[0-9a-f]{64}$/m.test(dockerfile)) {
    throw new Error("Managed desktop base image must remain digest pinned")
  }
  if (
    !dockerfile.includes(`'cua-computer-server[linux]==${RELEASE_IDENTITY.serverVersion}'`) ||
    !dockerfile.includes(`cognia.cua.protocol="${RELEASE_IDENTITY.protocol}"`) ||
    !dockerfile.includes(`cognia.cua.recipe="${RELEASE_IDENTITY.recipeRevision}"`)
  ) {
    throw new Error("Release identity does not match the desktop image recipe")
  }
  if (!dockerfile.includes("dpkg-query -W git nodejs npm")) {
    throw new Error("Managed desktop handoff image must verify git, nodejs and npm")
  }
  for (const key of ["protocol", "recipeRevision", "serverVersion"]) {
    if (!server.includes(`"${key}": "${RELEASE_IDENTITY[key]}"`)) {
      throw new Error(`Release ${key} does not match the authenticated guest health identity`)
    }
  }
}

export function parseArgs(args) {
  const values = {}
  const names = { "--image": "imageRepository", "--digest": "digest", "--output": "output" }
  for (let index = 0; index < args.length; index += 2) {
    const name = names[args[index]]
    const value = args[index + 1]
    if (!name || name in values || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: managed-desktop-release.mjs --image <repository> --digest <sha256> --output <file>"
      )
    }
    values[name] = value
  }
  if (Object.keys(values).length !== 3) {
    throw new Error("Image repository, published digest and output file are required")
  }
  return values
}

export function writeRelease(args, root = ROOT) {
  const { output, ...input } = parseArgs(args)
  const release = createManagedDesktopRelease(input)
  verifyImageSources(root)
  const path = resolve(output)
  mkdirSync(dirname(path), { recursive: true })
  const partial = `${path}.${process.pid}.partial`
  try {
    writeFileSync(partial, `${JSON.stringify(release, null, 2)}\n`, { flag: "wx", mode: 0o644 })
    renameSync(partial, path)
  } finally {
    rmSync(partial, { force: true })
  }
  return release
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = writeRelease(process.argv.slice(2))
    console.log(`Managed desktop release: ${release.image}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
