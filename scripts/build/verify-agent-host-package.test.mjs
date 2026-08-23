import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { verifyAgentHostPackage } from "./verify-agent-host-package.mjs"

function fixture(target, executable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-host-"))
  const packageRoot = path.join(root, "packages", `agent-host-${target}`)
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true })
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ bin: { "cognia-agent": `bin/${executable}` } })
  )
  for (const helperName of [
    "cognia-external-agent-launcher",
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
  return { root, packageRoot }
}

test("accepts a populated executable host package", () => {
  const { root, packageRoot } = fixture("darwin-arm64", "cognia-agent")
  try {
    const executable = path.join(packageRoot, "bin", "cognia-agent")
    fs.writeFileSync(executable, "host")
    fs.chmodSync(executable, 0o755)
    assert.equal(verifyAgentHostPackage(root, "darwin-arm64"), executable)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a platform package without its host payload", () => {
  const { root } = fixture("linux-x64", "cognia-agent")
  try {
    assert.throws(() => verifyAgentHostPackage(root, "linux-x64"), /missing .*bin.*cognia-agent/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("accepts the Windows executable without a Unix mode bit", () => {
  const { root, packageRoot } = fixture("win32-x64", "cognia-agent.exe")
  try {
    const executable = path.join(packageRoot, "bin", "cognia-agent.exe")
    fs.writeFileSync(executable, "host", { mode: 0o644 })
    assert.equal(verifyAgentHostPackage(root, "win32-x64"), executable)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a worker host without the Task Workspace helper", () => {
  const { root, packageRoot } = fixture("darwin-arm64", "cognia-agent")
  try {
    const executable = path.join(packageRoot, "bin", "cognia-agent")
    fs.writeFileSync(executable, "host")
    fs.chmodSync(executable, 0o755)
    fs.rmSync(path.join(packageRoot, "bin", "cognia-task-workspace-worker"))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /Task Workspace/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a host without the external agent launcher", () => {
  const { root, packageRoot } = fixture("darwin-arm64", "cognia-agent")
  try {
    const executable = path.join(packageRoot, "bin", "cognia-agent")
    fs.writeFileSync(executable, "host")
    fs.chmodSync(executable, 0o755)
    fs.rmSync(path.join(packageRoot, "bin", "cognia-external-agent-launcher"))
    assert.throws(() => verifyAgentHostPackage(root, "darwin-arm64"), /external agent/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("blocks packing a host with an incomplete parser grammar set", () => {
  const { root, packageRoot } = fixture("linux-x64", "cognia-agent")
  try {
    const executable = path.join(packageRoot, "bin", "cognia-agent")
    fs.writeFileSync(executable, "host")
    fs.chmodSync(executable, 0o755)
    fs.rmSync(path.join(packageRoot, "bin/grammars/tree-sitter-rust.wasm"))
    assert.throws(() => verifyAgentHostPackage(root, "linux-x64"), /tree-sitter-rust\.wasm/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
