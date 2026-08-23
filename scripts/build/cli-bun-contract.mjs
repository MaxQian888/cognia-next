const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    dist: "cognia-agent-macos-arm64",
    executable: "cognia-agent",
    claudePackage: "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    claudeBinary: "claude",
    archive: "tar.gz",
  }),
  "linux-x64": Object.freeze({
    name: "linux-x64",
    bunTarget: "bun-linux-x64-baseline",
    dist: "cognia-agent-linux-x64",
    executable: "cognia-agent",
    claudePackage: "@anthropic-ai/claude-agent-sdk-linux-x64",
    claudeBinary: "claude",
    archive: "tar.gz",
  }),
  "win32-x64": Object.freeze({
    name: "win32-x64",
    bunTarget: "bun-windows-x64-baseline",
    dist: "cognia-agent-win-x64",
    executable: "cognia-agent.exe",
    claudePackage: "@anthropic-ai/claude-agent-sdk-win32-x64",
    claudeBinary: "claude.exe",
    archive: "zip",
  }),
})

export function supportedCliTargets() {
  return Object.keys(TARGETS)
}

export function cliTarget(name) {
  const target = TARGETS[name]
  if (!target) throw new Error(`unknown CLI target: ${name}`)
  return target
}

export function hostTargetName(platform, arch) {
  const name = `${platform}-${arch}`
  if (TARGETS[name]) return name
  throw new Error(`unsupported CLI release host: ${name}`)
}

export function parseCliBuildArgs(argv, defaultTargetName) {
  let targetName = defaultTargetName
  let layoutOnly = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--layout-only") {
      layoutOnly = true
      continue
    }
    if (arg === "--target") {
      targetName = argv[++index]
      if (!targetName) throw new Error("--target requires a value")
      continue
    }
    if (arg.startsWith("--target=")) {
      targetName = arg.slice("--target=".length)
      continue
    }
    throw new Error(`unknown build argument: ${arg}`)
  }
  cliTarget(targetName)
  return { targetName, layoutOnly }
}
