import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  buildCliArtifactManifest,
  verifyCliArtifactLayout,
  writeCliArtifactManifest,
} from "./cli-artifact-integrity.mjs"

function fixture(variant, { windows = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-cli-layout-"))
  const executable = windows ? "cognia-agent.exe" : "cognia-agent"
  fs.writeFileSync(path.join(root, executable), "host")
  if (!windows) fs.chmodSync(path.join(root, executable), 0o755)
  if (variant === "full") {
    const claude = windows ? "claude.exe" : "claude"
    fs.writeFileSync(path.join(root, claude), "claude")
    if (!windows) fs.chmodSync(path.join(root, claude), 0o755)
  }
  fs.writeFileSync(path.join(root, "tree-sitter.wasm"), "resource")
  return root
}

test("full manifests include exactly one target-native Claude runtime", () => {
  const root = fixture("full")
  try {
    const manifest = buildCliArtifactManifest(root, "darwin-arm64", "full")
    assert.ok(manifest.files.claude)
    writeCliArtifactManifest(root, manifest)
    assert.deepEqual(verifyCliArtifactLayout(root, "darwin-arm64", "full"), manifest.files)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("slim manifests reject either Claude executable suffix", () => {
  const root = fixture("slim")
  try {
    writeCliArtifactManifest(root, buildCliArtifactManifest(root, "linux-x64", "slim"))
    assert.doesNotThrow(() => verifyCliArtifactLayout(root, "linux-x64", "slim"))
    fs.writeFileSync(path.join(root, "claude.exe"), "stray")
    assert.throws(
      () => verifyCliArtifactLayout(root, "linux-x64", "slim"),
      /slim.*must not contain.*Claude/s
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("full Windows manifests require claude.exe and reject claude", () => {
  const root = fixture("full", { windows: true })
  try {
    fs.renameSync(path.join(root, "claude.exe"), path.join(root, "claude"))
    writeCliArtifactManifest(root, buildCliArtifactManifest(root, "win32-x64", "full"))
    assert.throws(
      () => verifyCliArtifactLayout(root, "win32-x64", "full"),
      /exactly one.*claude\.exe/s
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("layout verification detects bytes changed after sealing", () => {
  const root = fixture("slim")
  try {
    writeCliArtifactManifest(root, buildCliArtifactManifest(root, "darwin-arm64", "slim"))
    fs.writeFileSync(path.join(root, "tree-sitter.wasm"), "tampered")
    assert.throws(() => verifyCliArtifactLayout(root, "darwin-arm64", "slim"), /integrity manifest/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
