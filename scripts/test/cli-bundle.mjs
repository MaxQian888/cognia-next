// One Node CLI artifact per Jest plan. Local suites still build current sources;
// CI consumers fail closed when the requested artifact cannot be verified.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hashFile, listPackagedFiles } from "../build/verify-agent-host-package.mjs"

const MANIFEST = ".cache/jest/cli-bundle.json"
const ARCHIVE = ".cache/jest/cli-bundle.tar"
const BUNDLE_DIR = "cli/dist"
export const CLI_BUNDLE_SUITES = [
  "cli/src/cli/entry.bundle.test.ts",
  "cli/src/cli/coding-loop.bundle.test.ts",
]

function checkoutHead(root) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
    throw new Error("CLI bundle checkout differs from GITHUB_SHA")
  }
  return head
}

function identity(root) {
  return {
    version: 1,
    head: checkoutHead(root),
    platform: process.platform,
    arch: process.arch,
    nodeMajor: process.versions.node.split(".")[0],
  }
}

export function cliBundleRequired(root, planFile, shard) {
  const plan = JSON.parse(fs.readFileSync(path.resolve(root, planFile), "utf8"))
  if (plan.head !== checkoutHead(root))
    throw new Error("CLI bundle test plan differs from checkout")
  const files =
    shard === undefined
      ? plan.testFiles
      : plan.shards?.find((entry) => entry.shard === Number(shard))?.testFiles
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    throw new Error("CLI bundle requires a valid plan/shard testFiles list")
  }
  return files.some((file) => CLI_BUNDLE_SUITES.includes(file))
}

function snapshot(directory) {
  const files = Object.fromEntries(
    listPackagedFiles(directory).map((relative) => {
      const file = path.join(directory, relative)
      const stat = fs.lstatSync(file)
      if (!stat.isFile()) throw new Error(`CLI bundle contains a non-regular file: ${relative}`)
      return [relative, { ...hashFile(file), mode: stat.mode & 0o777 }]
    })
  )
  if (!files["cognia-agent.mjs"]) throw new Error("CLI bundle entry is missing")
  return files
}

function readManifest(root, manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, manifestFile), "utf8"))
  for (const [key, expected] of Object.entries(identity(root))) {
    if (manifest[key] !== expected)
      throw new Error(`CLI bundle ${key} differs from checkout/runtime`)
  }
  return manifest
}

function verifyPayload(directory, manifest) {
  if (JSON.stringify(snapshot(directory)) !== JSON.stringify(manifest.files)) {
    throw new Error("CLI bundle file closure, digest or executable mode mismatch")
  }
}

function build(root, outdir) {
  // The coding tools are generated plugins. A cold checkout must build them
  // before esbuild embeds their catalog and --js-only stages their chunks.
  execFileSync(
    process.execPath,
    [path.join(root, "scripts/build/build-browser-builtin-plugins.mjs")],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 200_000,
    }
  )
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build/build-cli.mjs"),
      "--js-only",
      ...(outdir ? ["--outdir", outdir] : []),
    ],
    { cwd: root, stdio: "inherit", timeout: 200_000 }
  )
}

function temporaryLayout(root) {
  const parent = path.join(root, ".cache/jest")
  fs.mkdirSync(parent, { recursive: true })
  return fs.mkdtempSync(path.join(parent, "cli-bundle-"))
}

export function prepareCliBundle(root, planFile) {
  if (!cliBundleRequired(root, planFile)) {
    console.log("CLI bundle: no selected bundle suites")
    return
  }
  const expected = identity(root)
  // Do not label modified sources as an artifact of a committed SHA.
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root })
  const temporary = temporaryLayout(root)
  try {
    const output = path.join(temporary, BUNDLE_DIR)
    build(root, output)
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { cwd: root })
    if (checkoutHead(root) !== expected.head) throw new Error("Checkout changed during CLI build")
    const files = snapshot(output)
    execFileSync("tar", ["-cf", path.join(root, ARCHIVE), "-C", temporary, BUNDLE_DIR])
    fs.writeFileSync(
      path.join(root, MANIFEST),
      JSON.stringify(
        {
          ...expected,
          files,
          archive: hashFile(path.join(root, ARCHIVE)),
        },
        null,
        2
      ) + "\n"
    )
    console.log(`CLI bundle: prepared ${expected.head}`)
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "prepared=true\n")
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export function restoreCliBundle(root, planFile, shard) {
  if (!cliBundleRequired(root, planFile, shard)) return
  const manifest = readManifest(root, MANIFEST)
  const archive = path.join(root, ARCHIVE)
  if (JSON.stringify(hashFile(archive)) !== JSON.stringify(manifest.archive)) {
    throw new Error("CLI bundle archive digest mismatch")
  }
  const temporary = temporaryLayout(root)
  try {
    execFileSync("tar", ["-xf", archive, "-C", temporary])
    const output = path.join(temporary, BUNDLE_DIR)
    verifyPayload(output, manifest)
    // Only the explicit restore command replaces generated output. Consumers
    // validate without writing, so Jest workers cannot race bundle generation.
    fs.mkdirSync(path.join(root, "cli"), { recursive: true })
    fs.rmSync(path.join(root, BUNDLE_DIR), { recursive: true, force: true })
    fs.renameSync(output, path.join(root, BUNDLE_DIR))
    console.log(`CLI bundle: restored ${manifest.head}`)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export function ensureCliBundle(root, manifestFile = process.env.COGNIA_JEST_CLI_BUNDLE) {
  if (!manifestFile) {
    build(root)
    return
  }
  verifyPayload(path.join(root, BUNDLE_DIR), readManifest(root, manifestFile))
  console.log("CLI bundle: verified prepared artifact; no rebuild")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, planFile, shard, ...extra] = process.argv.slice(2)
  const root = process.cwd()
  if (command === "ensure" && !planFile) ensureCliBundle(root)
  else if (command === "prepare" && planFile && !shard) prepareCliBundle(root, planFile)
  else if (command === "required" && planFile && shard && !extra.length) {
    const required = cliBundleRequired(root, planFile, shard)
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\n`)
    console.log(`CLI bundle required: ${required}`)
  } else if (command === "restore" && planFile && shard && !extra.length) {
    restoreCliBundle(root, planFile, shard)
  } else
    throw new Error(
      "Usage: cli-bundle.mjs prepare <plan> | required/restore <plan> <shard> | ensure"
    )
}
