import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"

import { buildLinkedPackages, isPackageBuildFresh } from "./build-linked-packages.mjs"

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A package dir with `src/index.ts` stamped at `srcAt` and, optionally, `dist/index.js` at `distAt` (seconds). */
function fakePackage(name, { srcAt, distAt }) {
  const root = mkdtempSync(join(tmpdir(), "linked-pkg-"))
  dirs.push(root)
  const pkg = join(root, name)
  mkdirSync(join(pkg, "src"), { recursive: true })
  writeFileSync(join(pkg, "src", "index.ts"), "export const x = 1\n")
  writeFileSync(join(pkg, "package.json"), "{}\n")
  utimesSync(join(pkg, "src", "index.ts"), srcAt, srcAt)
  utimesSync(join(pkg, "package.json"), srcAt, srcAt)
  if (distAt !== undefined) {
    mkdirSync(join(pkg, "dist"))
    writeFileSync(join(pkg, "dist", "index.js"), "export const x = 1\n")
    utimesSync(join(pkg, "dist", "index.js"), distAt, distAt)
  }
  return pkg
}

test("a dist newer than every source is fresh", () => {
  assert.equal(isPackageBuildFresh(fakePackage("fresh", { srcAt: 1_000, distAt: 2_000 })), true)
})

test("a dist older than a source, or no dist at all, is stale", () => {
  assert.equal(isPackageBuildFresh(fakePackage("older", { srcAt: 2_000, distAt: 1_000 })), false)
  assert.equal(isPackageBuildFresh(fakePackage("missing", { srcAt: 1_000 })), false)
})

test("a root build input (tsup.config.ts) newer than dist makes it stale", () => {
  const pkg = fakePackage("config", { srcAt: 1_000, distAt: 2_000 })
  writeFileSync(join(pkg, "tsup.config.ts"), "export default {}\n")
  utimesSync(join(pkg, "tsup.config.ts"), 3_000, 3_000)
  assert.equal(isPackageBuildFresh(pkg), false)
})

test("buildLinkedPackages builds only the stale packages, through pnpm --filter", () => {
  const fresh = fakePackage("fresh-pkg", { srcAt: 1_000, distAt: 2_000 })
  const stale = fakePackage("stale-pkg", { srcAt: 2_000, distAt: 1_000 })
  const calls = []
  const lines = []
  buildLinkedPackages([fresh, stale], {
    label: "t",
    repoRoot: "/repo",
    run: (cmd, args, opts) => calls.push({ cmd, args, opts }),
    write: (s) => lines.push(s),
  })
  assert.deepEqual(calls, [
    { cmd: "pnpm", args: ["--filter", "@cognia/stale-pkg", "run", "build"], opts: { cwd: "/repo" } },
  ])
  assert.deepEqual(lines, [
    "[t] @cognia/fresh-pkg up to date; skipping build\n",
    "[t] building @cognia/stale-pkg\n",
  ])
})
