import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  INTEGRITY_MANIFEST,
  buildIntegrityManifest,
  listPackagedFiles,
  verifyAgentHostPackage,
  verifyIntegrityManifest,
  writeIntegrityManifest,
} from "./verify-agent-host-package.mjs"

function fixture(target, executable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-host-"))
  const packageRoot = path.join(root, "packages", `agent-host-${target}`)
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true })
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      bin: { "cognia-agent": `bin/${executable}` },
      files: ["bin", INTEGRITY_MANIFEST, "README.md"],
    })
  )
  for (const helperName of [
    "cognia-external-agent-launcher",
    "cognia-sandbox-exec",
    "cognia-task-workspace-worker",
  ]) {
    const helper = path.join(
      packageRoot,
      "bin",
      target === "win32-x64" ? `${helperName}.exe` : helperName
    )
    fs.writeFileSync(helper, `${helperName} helper`)
    if (target !== "win32-x64") fs.chmodSync(helper, 0o755)
  }
  const claude = path.join(packageRoot, "bin", target === "win32-x64" ? "claude.exe" : "claude")
  fs.writeFileSync(claude, "claude runtime")
  if (target !== "win32-x64") fs.chmodSync(claude, 0o755)

  const resources = {
    "sidecar/pi-extension/cognia-pi-extension.ts": "extension",
    "sidecar/pi-extension/integrity.json": "{}",
    "tree-sitter.wasm": "tree-sitter",
    "grammars/tree-sitter-python.wasm": "python",
    "grammars/tree-sitter-rust.wasm": "rust",
    "grammars/tree-sitter-tsx.wasm": "tsx",
    "grammars/tree-sitter-typescript.wasm": "typescript",
  }
  for (const [relativePath, contents] of Object.entries(resources)) {
    const resource = path.join(packageRoot, "bin", relativePath)
    fs.mkdirSync(path.dirname(resource), { recursive: true })
    fs.writeFileSync(resource, contents)
  }

  /** Record the closure of whatever is on disk right now, as the packager does. */
  const seal = () => writeIntegrityManifest(packageRoot, buildIntegrityManifest(packageRoot, target))
  return { root, packageRoot, seal }
}

/** Place the host executable and seal — the shape every happy-path test wants. */
function populate(packageRoot, executable, seal, { mode = 0o755 } = {}) {
  const file = path.join(packageRoot, "bin", executable)
  fs.writeFileSync(file, "host")
  fs.chmodSync(file, mode)
  seal()
  return file
}

test("accepts a populated executable host package", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    const executable = populate(packageRoot, "cognia-agent", seal)
    assert.equal(verifyAgentHostPackage(root, "darwin-arm64"), executable)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a platform package without its host payload", () => {
  const { root, seal } = fixture("linux-x64", "cognia-agent")
  try {
    seal()
    assert.throws(() => verifyAgentHostPackage(root, "linux-x64"), /missing .*bin.*cognia-agent/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("accepts the Windows executable without a Unix mode bit", () => {
  const { root, packageRoot, seal } = fixture("win32-x64", "cognia-agent.exe")
  try {
    const executable = populate(packageRoot, "cognia-agent.exe", seal, { mode: 0o644 })
    assert.equal(verifyAgentHostPackage(root, "win32-x64"), executable)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a worker host without the Task Workspace helper", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.rmSync(path.join(packageRoot, "bin", "cognia-task-workspace-worker"))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /Task Workspace/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a host without the external agent launcher", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.rmSync(path.join(packageRoot, "bin", "cognia-external-agent-launcher"))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /external agent/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a full host without its target-native Claude runtime", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.rmSync(path.join(packageRoot, "bin", "claude"))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /Claude runtime/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("requires the Windows Claude runtime suffix", () => {
  const { root, packageRoot, seal } = fixture("win32-x64", "cognia-agent.exe")
  try {
    populate(packageRoot, "cognia-agent.exe", seal, { mode: 0o644 })
    fs.renameSync(path.join(packageRoot, "bin", "claude.exe"), path.join(packageRoot, "bin", "claude"))
    assert.throws(() => verifyAgentHostPackage(root, "win32-x64"), /claude\.exe.*Claude runtime/s)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a host with an incomplete parser grammar set", () => {
  const { root, packageRoot, seal } = fixture("linux-x64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.rmSync(path.join(packageRoot, "bin/grammars/tree-sitter-rust.wasm"))
    assert.throws(() => verifyAgentHostPackage(root, "linux-x64"), /tree-sitter-rust\.wasm/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- closure manifest -------------------------------------------------------

test("refuses a package that was never sealed", () => {
  const { root, packageRoot } = fixture("darwin-arm64", "cognia-agent")
  try {
    const file = path.join(packageRoot, "bin", "cognia-agent")
    fs.writeFileSync(file, "host")
    fs.chmodSync(file, 0o755)
    assert.throws(
      () => verifyAgentHostPackage(root, "darwin-arm64"),
      /missing .*integrity\.json.*agent:host:package/s
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a package whose payload changed after it was sealed", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.writeFileSync(path.join(packageRoot, "bin", "tree-sitter.wasm"), "tampered")
    assert.throws(
      () => verifyAgentHostPackage(root, "darwin-arm64"),
      /tree-sitter\.wasm does not match the integrity manifest/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a stray file the manifest never declared", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.writeFileSync(path.join(packageRoot, "bin", "leftover.dylib"), "stowaway")
    assert.throws(
      () => verifyAgentHostPackage(root, "darwin-arm64"),
      /does not declare:\n {2}bin\/leftover\.dylib/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a stray file nested below a declared directory", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    fs.writeFileSync(path.join(packageRoot, "bin/grammars/tree-sitter-go.wasm"), "go")
    assert.throws(
      () => verifyAgentHostPackage(root, "darwin-arm64"),
      /bin\/grammars\/tree-sitter-go\.wasm/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a manifest built for another target", () => {
  const { root, packageRoot } = fixture("darwin-arm64", "cognia-agent")
  try {
    const file = path.join(packageRoot, "bin", "cognia-agent")
    fs.writeFileSync(file, "host")
    fs.chmodSync(file, 0o755)
    writeIntegrityManifest(packageRoot, buildIntegrityManifest(packageRoot, "linux-x64"))
    assert.throws(
      () => verifyAgentHostPackage(root, "darwin-arm64"),
      /was built for linux-x64, not darwin-arm64/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a manifest from a future schema", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    const file = path.join(packageRoot, INTEGRITY_MANIFEST)
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    fs.writeFileSync(file, JSON.stringify({ ...manifest, schemaVersion: 99 }))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /schemaVersion 99/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("refuses a package that does not publish its manifest", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    const packageJson = path.join(packageRoot, "package.json")
    const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"))
    fs.writeFileSync(packageJson, JSON.stringify({ ...parsed, files: ["bin", "README.md"] }))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /must publish integrity\.json/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("lists packaged files depth-first in a stable sorted order", () => {
  const { root, packageRoot } = fixture("darwin-arm64", "cognia-agent")
  try {
    const listed = listPackagedFiles(path.join(packageRoot, "bin"))
    assert.deepEqual(listed, [...listed].sort(), "order must be stable across machines")
    assert.ok(listed.includes("grammars/tree-sitter-rust.wasm"), "nested files are recorded")
    assert.ok(!listed.includes("grammars"), "directories are not recorded")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("counts the files it verified", () => {
  const { root, packageRoot, seal } = fixture("darwin-arm64", "cognia-agent")
  try {
    populate(packageRoot, "cognia-agent", seal)
    const expected = listPackagedFiles(path.join(packageRoot, "bin")).length
    assert.equal(verifyIntegrityManifest(root, packageRoot, "darwin-arm64"), expected)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
