import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import {
  clonedepsTools,
  cloneDepSourceTool,
  listClonedDepsTool,
  CLONEDEPS_TOOL_NAMES,
  __testExports,
} from "./index.mjs"
import { MANIFEST_REL } from "./manifest.mjs"

const { execCloneDepSource, execListClonedDeps } = __testExports
const ROOT = path.sep === "\\" ? "C:\\repo" : "/repo"

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
    writeFile: async (p, c) => files.set(p, c),
    mkdir: async (p) => dirs.add(p),
    exists: async (p) => files.has(p) || dirs.has(p),
  }
}

function makeFakeGit(fs) {
  const runGit = async (args) => {
    if (args[0] === "rev-parse") return { stdout: `${ROOT}\n`, stderr: "" }
    if (args[0] === "clone") {
      fs.dirs.add(args[args.length - 1])
      return { stdout: "", stderr: "" }
    }
    return { stdout: "", stderr: "" }
  }
  return { runGit }
}

function jsonOf(result) {
  return JSON.parse(result.content[0].text)
}

test("category exports the two tools in stable order", () => {
  assert.deepEqual(CLONEDEPS_TOOL_NAMES, ["clone_dep_source", "list_cloned_deps"])
  assert.deepEqual(
    clonedepsTools.map((t) => t.name),
    CLONEDEPS_TOOL_NAMES
  )
  assert.equal(cloneDepSourceTool.name, "clone_dep_source")
  assert.equal(listClonedDepsTool.name, "list_cloned_deps")
})

test("execCloneDepSource clones and reports the manifest count", async () => {
  const fs = makeFakeFs()
  const git = makeFakeGit(fs)
  const r = await execCloneDepSource(
    { cwd: ROOT, repoUrl: "https://github.com/a/b.git", reason: "internals" },
    { ...git, fs, now: () => "2026-06-29T00:00:00.000Z" }
  )
  assert.ok(!r.isError)
  const body = jsonOf(r)
  assert.equal(body.cloned, true)
  assert.equal(body.dependencyCount, 1)
  assert.match(body.message, /Cloned at \.cognia\/clonedeps\/repos\/a__b/)
})

test("execCloneDepSource surfaces a rejection (non-HTTPS) as a tool error", async () => {
  const r = await execCloneDepSource(
    { cwd: ROOT, repoUrl: "git@github.com:a/b.git" },
    { ...makeFakeGit(makeFakeFs()), fs: makeFakeFs() }
  )
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /clone_dep_source: Only HTTPS/)
})

test("execListClonedDeps reports the manifest contents", async () => {
  const fs = makeFakeFs({
    [path.join(ROOT, MANIFEST_REL)]: JSON.stringify({
      version: "1.0.0",
      updatedAt: "t",
      dependencies: [{ repoUrl: "https://x/y.git", path: "p", reason: "r" }],
    }),
  })
  const r = await execListClonedDeps({ cwd: ROOT }, { ...makeFakeGit(fs), fs })
  assert.ok(!r.isError)
  const body = jsonOf(r)
  assert.equal(body.count, 1)
  assert.equal(body.manifest, ".cognia/clonedeps.json")
})

test("execListClonedDeps surfaces errors (not a repo) as a tool error", async () => {
  const fs = makeFakeFs()
  const failingGit = {
    runGit: async () => {
      throw new Error("not a git repository")
    },
  }
  const r = await execListClonedDeps({ cwd: ROOT }, { ...failingGit, fs })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /list_cloned_deps: not a git repository/)
})
