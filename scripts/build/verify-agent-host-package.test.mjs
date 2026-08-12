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
  const helper = path.join(
    packageRoot,
    "bin",
    target === "win32-x64"
      ? "cognia-task-workspace-worker.exe"
      : "cognia-task-workspace-worker"
  )
  fs.writeFileSync(helper, "workspace helper")
  if (target !== "win32-x64") fs.chmodSync(helper, 0o755)
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
