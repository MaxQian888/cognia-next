import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  buildIntegrityManifest,
  writeIntegrityManifest,
} from "../build/verify-agent-host-package.mjs"
import { nativeHostFileNames } from "../build/native-host-files.mjs"
import {
  prepareReleaseHost,
  restoreReleaseHost,
  releaseHostEnvironment,
  selectReleaseHost,
} from "./release-agent-host.mjs"

const target = `${process.platform}-${process.arch}`
const packagePath = `packages/agent-host-${target}`
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-agent-host-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packageRoot = path.join(root, packagePath)
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(root, ".gitignore"), "bin/\nintegrity.json\n.cache/\n")
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: `@cognia/agent-host-${target}`,
      version: "0.1.0",
      bin: { "cognia-agent": "bin/cognia-agent" },
      files: ["bin", "integrity.json"],
    })
  )
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  git("init", "--quiet")
  git("add", ".gitignore", `${packagePath}/package.json`)
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  )
  const env = {
    GITHUB_SHA: git("rev-parse", "HEAD"),
    GITHUB_REPOSITORY: "fixture/repo",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  }
  for (const file of [
    "cognia-agent",
    "claude",
    ...nativeHostFileNames(),
    "sidecar/pi-extension/cognia-pi-extension.ts",
    "sidecar/pi-extension/cognia-pi-shell-guard.ts",
    "sidecar/pi-extension/integrity.json",
    "tree-sitter.wasm",
    ...["python", "rust", "tsx", "typescript"].map(
      (language) => `grammars/tree-sitter-${language}.wasm`
    ),
  ]) {
    const output = path.join(packageRoot, "bin", file)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, file)
    fs.chmodSync(output, 0o755)
  }
  writeIntegrityManifest(packageRoot, buildIntegrityManifest(packageRoot, target))
  return { root, packageRoot, env, artifact: path.join(root, ".cache/release-agent-host") }
}

test("restores a same-run host in a clean checkout and exports its native helper paths", (t) => {
  const { root, packageRoot, env, artifact } = fixture(t)
  prepareReleaseHost(root, env)
  const consumer = path.join(root, "consumer")
  execFileSync("git", ["clone", "--quiet", root, consumer])
  fs.mkdirSync(path.join(consumer, ".cache"))
  fs.cpSync(artifact, path.join(consumer, ".cache/release-agent-host"), { recursive: true })
  restoreReleaseHost(consumer, { ...env, GITHUB_RUN_ATTEMPT: "2" })
  assert.equal(
    fs.readFileSync(path.join(consumer, packagePath, "bin/cognia-agent"), "utf8"),
    "cognia-agent"
  )
  assert.equal(
    fs.statSync(path.join(consumer, packagePath, "bin/cognia-agent")).mode & 0o777,
    0o755
  )
  const overrides = releaseHostEnvironment(consumer)
  assert.equal(Object.keys(overrides).length, nativeHostFileNames().length)
  for (const file of Object.values(overrides)) {
    assert.ok(file.startsWith(path.join(consumer, packagePath, "bin")))
    assert.ok(fs.existsSync(file))
  }
  assert.equal(fs.readFileSync(path.join(packageRoot, "bin/cognia-agent"), "utf8"), "cognia-agent")
})

test("does not label modified tracked sources as the committed release", (t) => {
  const { root, packageRoot, env } = fixture(t)
  fs.appendFileSync(path.join(packageRoot, "package.json"), "\n")
  assert.throws(() => prepareReleaseHost(root, env), /git/)
})

for (const [key, value] of [
  ["head", "f".repeat(40)],
  ["repository", "other/repo"],
  ["runId", "456"],
  ["target", "wrong-target"],
  ["attempt", 99],
  ["version", 99],
]) {
  test(`rejects mismatched ${key} without replacing the installed package`, (t) => {
    const { root, packageRoot, env, artifact } = fixture(t)
    prepareReleaseHost(root, env)
    const file = path.join(artifact, "manifest.json")
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    fs.writeFileSync(file, JSON.stringify({ ...manifest, [key]: value }))
    assert.throws(() => restoreReleaseHost(root, env), /identity|attempt/)
    assert.equal(
      fs.readFileSync(path.join(packageRoot, "bin/cognia-agent"), "utf8"),
      "cognia-agent"
    )
  })
}

test("rejects corrupt archives and missing files rather than falling back after verification failure", (t) => {
  const { root, env, artifact } = fixture(t)
  prepareReleaseHost(root, env)
  fs.appendFileSync(path.join(artifact, "host.tar.gz"), "corrupted")
  assert.throws(() => restoreReleaseHost(root, env), /archive digest/)
  fs.rmSync(path.join(artifact, "manifest.json"))
  assert.throws(() => restoreReleaseHost(root, env), /ENOENT/)
})

test("rejects incomplete or changed native helpers before export or upload", (t) => {
  const { root, packageRoot, env } = fixture(t)
  fs.rmSync(path.join(packageRoot, "bin", nativeHostFileNames()[0]))
  assert.throws(() => prepareReleaseHost(root, env), /missing/)
  assert.throws(() => releaseHostEnvironment(root), /missing/)
})

test("rejects symlinks in the release payload", (t) => {
  const { root, packageRoot, env } = fixture(t)
  fs.symlinkSync("tree-sitter.wasm", path.join(packageRoot, "bin/alias.wasm"))
  writeIntegrityManifest(packageRoot, buildIntegrityManifest(packageRoot, target))
  assert.throws(() => prepareReleaseHost(root, env), /regular file/)
})

test("only an absent or expired same-run artifact selects the cold fallback", async (t) => {
  const { root, env } = fixture(t)
  const artifact = {
    id: 42,
    name: `release-agent-host-${target}-${env.GITHUB_SHA}`,
    expired: false,
    workflow_run: { id: 123, head_sha: env.GITHUB_SHA },
  }
  const client = (artifacts) => ({
    listArtifacts: async ({ runId }) => {
      assert.equal(runId, env.GITHUB_RUN_ID)
      return artifacts
    },
  })
  assert.equal(await selectReleaseHost(root, env, client([artifact])), "42")
  assert.equal(await selectReleaseHost(root, env, client([])), "")
  assert.equal(await selectReleaseHost(root, env, client([{ ...artifact, expired: true }])), "")
  await assert.rejects(selectReleaseHost(root, env, client([artifact, artifact])), /multiple/)
  await assert.rejects(
    selectReleaseHost(root, env, client([{ ...artifact, workflow_run: { id: 456 } }])),
    /identity/
  )
  await assert.rejects(
    selectReleaseHost(root, env, {
      listArtifacts: async () => {
        throw new Error("403")
      },
    }),
    /403/
  )
})
