import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PLUGIN_NODE_VERSION = "26.3.1"

export const PLUGIN_NODE_ARCHIVES = Object.freeze({
  "darwin-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-darwin-arm64.tar.xz`,
    sha256: "49aca22a8c2992c16688baa512a7b00c41a4608e9675fcaa81534767bf1116ce",
  },
  "darwin-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-darwin-x64.tar.xz`,
    sha256: "dac58e340c721332d331a44c9ee2e126b26632c42d3028eb2ceb5c3f218798fa",
  },
  "linux-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-linux-arm64.tar.xz`,
    sha256: "c021380e64d1314d1218ab1f31e0f5b0f28f1f54ac779ef72a16c2bda0ca5c30",
  },
  "linux-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-linux-x64.tar.xz`,
    sha256: "55647180e4ae58ffeaa3294e89aa4abda7c371dfbd64b44cbdb022980177aae0",
  },
  "win32-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-win-arm64.zip`,
    sha256: "021eb7de1d5257b24765f292dfcb469ff1528c29d88f48c875befb28114fb0fb",
  },
  "win32-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-win-x64.zip`,
    sha256: "45001b289ebffe7b22260898f3750059183d8246042b88e8ffa4337e65e6763e",
  },
})

export function archiveFor(platform = process.platform, arch = process.arch) {
  const archive = PLUGIN_NODE_ARCHIVES[`${platform}-${arch}`]
  if (!archive) {
    throw new Error(`Unsupported plugin Node runtime target: ${platform}-${arch}`)
  }
  return archive
}

export function verifyArchive(bytes, expectedSha256) {
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== expectedSha256) {
    throw new Error(`Plugin Node archive checksum mismatch: expected ${expectedSha256}, got ${actual}`)
  }
}

function runtimeVersion(binary) {
  return execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
}

export async function preparePluginNode({ check = false } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const destination = join(root, "src-tauri", "resources", "plugin-node")
  const executableName = process.platform === "win32" ? "node.exe" : "node"
  const binary = join(destination, "bin", executableName)
  if (existsSync(binary) && runtimeVersion(binary) === `v${PLUGIN_NODE_VERSION}`) {
    return binary
  }
  if (check) {
    throw new Error(`Verified plugin Node v${PLUGIN_NODE_VERSION} runtime is missing at ${binary}`)
  }

  const archive = archiveFor()
  const work = mkdtempSync(join(tmpdir(), "cognia-plugin-node-"))
  try {
    const response = await fetch(`https://nodejs.org/dist/v${PLUGIN_NODE_VERSION}/${archive.file}`)
    if (!response.ok) {
      throw new Error(`Plugin Node download failed: HTTP ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    verifyArchive(bytes, archive.sha256)
    const archivePath = join(work, archive.file)
    writeFileSync(archivePath, bytes)
    const extracted = spawnSync("tar", ["-xf", archivePath, "-C", work], {
      encoding: "utf8",
    })
    if (extracted.status !== 0) {
      throw new Error(`Plugin Node extraction failed: ${extracted.stderr || extracted.stdout}`)
    }

    const sourceRoot = join(work, basename(archive.file).replace(/\.(?:tar\.xz|zip)$/, ""))
    const sourceBinary = join(sourceRoot, executableName === "node.exe" ? "node.exe" : "bin/node")
    const staging = join(dirname(destination), `.plugin-node-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, "bin"), { recursive: true })
    copyFileSync(sourceBinary, join(staging, "bin", executableName))
    copyFileSync(join(sourceRoot, "LICENSE"), join(staging, "LICENSE"))
    if (process.platform !== "win32") {
      chmodSync(join(staging, "bin", executableName), 0o755)
    }
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
    if (runtimeVersion(binary) !== `v${PLUGIN_NODE_VERSION}`) {
      throw new Error("Prepared plugin Node runtime failed its version smoke test")
    }
    return binary
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await preparePluginNode({ check: process.argv.includes("--check") })
}
