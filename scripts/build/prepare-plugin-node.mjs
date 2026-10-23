import { createHash } from "node:crypto"
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
import { Command, CommanderError } from "commander"
import { execaSync } from "execa"
import { z } from "zod"

export const PLUGIN_NODE_VERSION = "26.12.1"

export const PLUGIN_NODE_ARCHIVES = Object.freeze({
  "darwin-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-darwin-arm64.tar.xz`,
    sha256: "18830bf448fe187c650dc28c98aa8c968ed1d40b6dd032c081e70a384a1bf660",
  },
  "darwin-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-darwin-x64.tar.xz`,
    sha256: "69316aaafb4dfcb25ac7b9a460f5c60928a37580284fde410144d0e6c8672d0f",
  },
  "linux-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-linux-arm64.tar.xz`,
    sha256: "42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb",
  },
  "linux-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-linux-x64.tar.xz`,
    sha256: "6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd",
  },
  "win32-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-win-arm64.zip`,
    sha256: "34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c",
  },
  "win32-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-win-x64.zip`,
    sha256: "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4",
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
  return execaSync(binary, ["--version"]).stdout.trim()
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
    const extracted = execaSync("tar", ["-xf", archivePath, "-C", work], {
      all: true,
      reject: false,
    })
    if (extracted.exitCode !== 0 || extracted.signal) {
      throw new Error(`Plugin Node extraction failed: ${extracted.all}`)
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

const cliSchema = z.object({ check: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm plugin-node:prepare")
    .description("Prepare or verify Cognia's pinned plugin Node.js runtime.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--check", "Verify the pinned runtime without downloading it.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options) await preparePluginNode(options)
}
