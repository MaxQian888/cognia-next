import fs from "node:fs"
import path from "node:path"

import { hashFile, listPackagedFiles } from "./verify-agent-host-package.mjs"

export const CLI_INTEGRITY_MANIFEST = "integrity.json"
const SCHEMA_VERSION = 1

function expectedClaudeName(targetName) {
  return targetName === "win32-x64" ? "claude.exe" : "claude"
}

function payloadFiles(layoutRoot) {
  return listPackagedFiles(layoutRoot).filter((relative) => relative !== CLI_INTEGRITY_MANIFEST)
}

export function buildCliArtifactManifest(layoutRoot, targetName, variant) {
  const files = {}
  for (const relative of payloadFiles(layoutRoot)) {
    files[relative] = hashFile(path.join(layoutRoot, relative))
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    target: targetName,
    variant,
    files,
  }
}

export function writeCliArtifactManifest(layoutRoot, manifest) {
  const destination = path.join(layoutRoot, CLI_INTEGRITY_MANIFEST)
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`)
  return destination
}

export function verifyCliArtifactLayout(layoutRoot, targetName, variant) {
  const claudeFiles = ["claude", "claude.exe"].filter((name) =>
    fs.statSync(path.join(layoutRoot, name), { throwIfNoEntry: false })?.isFile()
  )
  if (variant === "slim" && claudeFiles.length > 0) {
    throw new Error(`slim artifact must not contain a Claude executable: ${claudeFiles.join(", ")}`)
  }
  const expectedClaude = expectedClaudeName(targetName)
  if (variant === "full" && (claudeFiles.length !== 1 || claudeFiles[0] !== expectedClaude)) {
    throw new Error(`full ${targetName} artifact must contain exactly one ${expectedClaude}`)
  }

  const manifestFile = path.join(layoutRoot, CLI_INTEGRITY_MANIFEST)
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"))
  } catch (cause) {
    throw new Error(`missing or invalid CLI integrity manifest: ${manifestFile}`, { cause })
  }
  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    manifest.target !== targetName ||
    manifest.variant !== variant
  ) {
    throw new Error(`CLI integrity manifest does not describe ${targetName}/${variant}`)
  }

  const actualPaths = payloadFiles(layoutRoot)
  const declaredPaths = Object.keys(manifest.files ?? {}).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error("CLI integrity manifest does not match the artifact file closure")
  }
  for (const relative of declaredPaths) {
    const actual = hashFile(path.join(layoutRoot, relative))
    const expected = manifest.files[relative]
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`CLI integrity manifest mismatch for ${relative}`)
    }
  }
  return manifest.files
}
