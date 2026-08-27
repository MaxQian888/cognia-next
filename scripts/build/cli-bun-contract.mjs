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

export function cliLayoutName(target, variant) {
  if (variant === "full") return target.dist
  if (variant === "slim") return `${target.dist}-slim`
  throw new Error(`unknown CLI variant: ${variant}`)
}

export function cliArchiveName(target, variant) {
  return `${cliLayoutName(target, variant)}.${target.archive}`
}

export function parseCliBuildArgs(argv, defaultTargetName) {
  let targetName = defaultTargetName
  let layoutOnly = false
  let variant = "full"
  let archive = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--layout-only") {
      layoutOnly = true
      continue
    }
    if (arg === "--archive") {
      archive = true
      continue
    }
    if (arg === "--variant") {
      variant = argv[++index]
      if (!variant) throw new Error("--variant requires a value")
      continue
    }
    if (arg.startsWith("--variant=")) {
      variant = arg.slice("--variant=".length)
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
  if (!["full", "slim", "all"].includes(variant)) {
    throw new Error(`unknown CLI variant: ${variant}`)
  }
  if (layoutOnly && (variant !== "full" || archive)) {
    throw new Error("--layout-only cannot be combined with --variant or --archive")
  }
  return { targetName, layoutOnly, variant, archive }
}
