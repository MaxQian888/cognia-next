import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import {
  clonedepsTools,
  cloneDepSourceTool,
  listClonedDepsTool,
  CLONEDEPS_TOOL_NAMES,
  __testExports,
} from "./index.ts"
import { MANIFEST_REL } from "./manifest.ts"
import { firstText, firstJson } from "../../../../test-support/tool-result.ts"

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
} & import("./clone.ts").ClonedepsDeps["fs"]

const { execCloneDepSource, execListClonedDeps } = __testExports
const ROOT = path.sep === "\\" ? "C:\\repo" : "/repo"

function makeFakeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return files.get(p) as string
    },
    writeFile: async (p: string, c: string) => files.set(p, c),
    mkdir: async (p: string) => dirs.add(p),
    exists: async (p: string) => files.has(p) || dirs.has(p),
  }
}

function makeFakeGit(fs: FakeFs) {
  const runGit = async (args: string[]) => {
    if (args[0] === "rev-parse") return { stdout: `${ROOT}\n`, stderr: "" }
    if (args[0] === "clone") {
      fs.dirs.add(args[args.length - 1]!)
      return { stdout: "", stderr: "" }
    }
    return { stdout: "", stderr: "" }
  }
  return { runGit }
}

interface CloneOutput {
  cloned: boolean
  dependencyCount: number
  message: string
  count: number
  manifest: string
  dependencies: { name?: string }[]
}

function jsonOf(result: { content: readonly unknown[] }): CloneOutput {
  return firstJson<CloneOutput>(result)
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
  assert.match(firstText(r), /clone_dep_source: Only HTTPS/)
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
  assert.match(firstText(r), /list_cloned_deps: not a git repository/)
})
