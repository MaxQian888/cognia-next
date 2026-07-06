import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { cloneDependencySource, listClonedDeps } from "./clone.mjs"
import { MANIFEST_REL, parseManifest } from "./manifest.mjs"
import { MARKER_START } from "./gitignore.mjs"

const ROOT = path.join(path.sep === "\\" ? "C:\\repo" : "/repo")

/** In-memory fs honouring the deps.fs contract clone.mjs expects. */
function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = new Set()
  return {
    files,
    dirs,
    readFile: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return files.get(p)
    },
    writeFile: async (p, c) => {
      files.set(p, c)
    },
    mkdir: async (p) => {
      dirs.add(p)
    },
    exists: async (p) => files.has(p) || dirs.has(p),
  }
}

/** Fake git: answers rev-parse with ROOT; records clone and "creates" the target dir. */
function makeFakeGit(fs, { failClone } = {}) {
  const calls = []
  const runGit = async (args) => {
    calls.push(args)
    if (args[0] === "rev-parse") return { stdout: `${ROOT}\n`, stderr: "" }
    if (args[0] === "clone") {
      if (failClone) throw new Error("fatal: repository not found")
      fs.dirs.add(args[args.length - 1]) // the absolute target
      return { stdout: "", stderr: "" }
    }
    return { stdout: "", stderr: "" }
  }
  return { runGit, calls }
}

const NOW = "2026-06-29T00:00:00.000Z"
const manifestPath = path.join(ROOT, MANIFEST_REL)
const gitignorePath = path.join(ROOT, ".gitignore")

test("cloneDependencySource clones, writes manifest, and ignores the repos dir", async () => {
  const fs = makeFakeFs()
  const git = makeFakeGit(fs)
  const res = await cloneDependencySource(
    {
      cwd: ROOT,
      repoUrl: "https://github.com/opencode-ai/opencode.git",
      reason: "SDK internals",
      name: "@opencode-ai/sdk",
      packagePath: "packages/sdk",
    },
    { ...git, fs, now: () => NOW }
  )

  assert.equal(res.cloned, true)
  assert.equal(res.reused, false)
  assert.equal(res.name, "opencode-ai__opencode")
  assert.equal(res.path, ".cognia/clonedeps/repos/opencode-ai__opencode")
  assert.equal(res.dependencyCount, 1)

  // A clone was issued with shallow depth.
  const clone = git.calls.find((c) => c[0] === "clone")
  assert.ok(clone.includes("--depth") && clone.includes("1"))

  // Manifest persisted with the dependency.
  const manifest = parseManifest(fs.files.get(manifestPath))
  assert.equal(manifest.dependencies.length, 1)
  assert.equal(manifest.dependencies[0].name, "@opencode-ai/sdk")
  assert.equal(manifest.updatedAt, NOW)

  // .gitignore now carries the managed block.
  assert.ok(fs.files.get(gitignorePath).includes(MARKER_START))
})

test("cloneDependencySource is idempotent — an existing clone is reused, not re-cloned", async () => {
  const fs = makeFakeFs()
  const git = makeFakeGit(fs)
  // Pre-create the target dir.
  fs.dirs.add(path.join(ROOT, ".cognia", "clonedeps", "repos", "opencode-ai__opencode"))

  const res = await cloneDependencySource(
    { cwd: ROOT, repoUrl: "https://github.com/opencode-ai/opencode.git" },
    { ...git, fs, now: () => NOW }
  )
  assert.equal(res.reused, true)
  assert.equal(res.cloned, false)
  assert.ok(!git.calls.some((c) => c[0] === "clone"))
  // Manifest still recorded.
  assert.equal(parseManifest(fs.files.get(manifestPath)).dependencies.length, 1)
})

test("cloneDependencySource threads a ref as --branch", async () => {
  const fs = makeFakeFs()
  const git = makeFakeGit(fs)
  await cloneDependencySource(
    { cwd: ROOT, repoUrl: "https://github.com/a/b.git", ref: "v1.2.3" },
    { ...git, fs, now: () => NOW }
  )
  const clone = git.calls.find((c) => c[0] === "clone")
  assert.deepEqual(clone.slice(clone.indexOf("--branch"), clone.indexOf("--branch") + 2), [
    "--branch",
    "v1.2.3",
  ])
})

test("cloneDependencySource rejects non-HTTPS URLs before touching git", async () => {
  const fs = makeFakeFs()
  const git = makeFakeGit(fs)
  await assert.rejects(
    cloneDependencySource(
      { cwd: ROOT, repoUrl: "git@github.com:a/b.git" },
      { ...git, fs, now: () => NOW }
    ),
    /Only HTTPS/
  )
  assert.equal(git.calls.length, 0)
})

test("cloneDependencySource requires a repoUrl", async () => {
  await assert.rejects(
    cloneDependencySource({ cwd: ROOT }, { fs: makeFakeFs() }),
    /repoUrl is required/
  )
})

test("listClonedDeps returns the manifest dependencies", async () => {
  const fs = makeFakeFs({
    [manifestPath]: JSON.stringify({
      version: "1.0.0",
      updatedAt: NOW,
      dependencies: [
        { repoUrl: "https://x/y.git", path: ".cognia/clonedeps/repos/x__y", reason: "r" },
      ],
    }),
  })
  const git = makeFakeGit(fs)
  const res = await listClonedDeps({ cwd: ROOT }, { ...git, fs })
  assert.equal(res.path, ".cognia/clonedeps.json")
  assert.equal(res.dependencies.length, 1)
  assert.equal(res.dependencies[0].reason, "r")
})

test("listClonedDeps returns empty when no manifest exists", async () => {
  const fs = makeFakeFs()
  const git = makeFakeGit(fs)
  const res = await listClonedDeps({ cwd: ROOT }, { ...git, fs })
  assert.deepEqual(res.dependencies, [])
})
