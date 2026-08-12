import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TARGETS = {
  "darwin-arm64": { packageDir: "agent-host-darwin-arm64", executable: "cognia-agent" },
  "linux-x64": { packageDir: "agent-host-linux-x64", executable: "cognia-agent" },
  "win32-x64": { packageDir: "agent-host-win32-x64", executable: "cognia-agent.exe" },
}

export function verifyAgentHostPackage(root, targetName) {
  const target = TARGETS[targetName]
  if (!target) throw new Error(`unknown agent host target: ${targetName}`)
  const packageRoot = path.join(root, "packages", target.packageDir)
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
  const relativeExecutable = `bin/${target.executable}`
  if (manifest.bin?.["cognia-agent"] !== relativeExecutable) {
    throw new Error(`${target.packageDir} must expose ${relativeExecutable}`)
  }
  const executable = path.join(packageRoot, relativeExecutable)
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `missing ${path.relative(root, executable)}; run pnpm cli:build:binary and pnpm agent:host:package -- ${targetName}`
    )
  }
  if (targetName !== "win32-x64" && (fs.statSync(executable).mode & 0o111) === 0) {
    throw new Error(`${path.relative(root, executable)} is not executable`)
  }
  const helperName = targetName === "win32-x64"
    ? "cognia-task-workspace-worker.exe"
    : "cognia-task-workspace-worker"
  const helper = path.join(packageRoot, "bin", helperName)
  if (!fs.statSync(helper, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`missing ${path.relative(root, helper)}; worker dispatch requires Task Workspace`)
  }
  if (targetName !== "win32-x64" && (fs.statSync(helper).mode & 0o111) === 0) {
    throw new Error(`${path.relative(root, helper)} is not executable`)
  }
  return executable
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, "../..")
  const targetName = process.argv[2]
  verifyAgentHostPackage(root, targetName)
  process.stdout.write(`verified ${targetName} agent host package\n`)
}
