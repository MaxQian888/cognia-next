import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const driver = fileURLToPath(new URL("./cli-bundle.mjs", import.meta.url))
const manifestPath = ".cache/jest/cli-bundle.json"
const suite = "cli/src/cli/entry.bundle.test.ts"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jest-cli-artifact-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "--quiet")
  git("config", "user.name", "Artifact Test")
  git("config", "user.email", "artifact@example.invalid")
  fs.mkdirSync(path.join(root, "scripts/build"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    ".cache/\ncli/dist/\npublic/\nbuild-count\nplugin-build-count\n"
  )
  fs.writeFileSync(
    path.join(root, "scripts/build/build-browser-builtin-plugins.mjs"),
    `
    import fs from 'node:fs';
    if (process.env.FIXTURE_PLUGIN_BUILD_FAIL) throw new Error('plugin build failed');
    fs.mkdirSync('public/_cognia/builtin-plugins', {recursive:true});
    fs.writeFileSync('public/_cognia/builtin-plugins/fixture.cjs', 'module.exports = "plugin-ok"');
    fs.appendFileSync('plugin-build-count', 'build\\n');
  `
  )
  // A real child-process builder at the production command boundary. The
  // fixture has no esbuild dependency; the real CLI suites cover that build.
  fs.writeFileSync(
    path.join(root, "scripts/build/build-cli.mjs"),
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const index = process.argv.indexOf('--outdir');
    const out = index < 0 ? 'cli/dist' : process.argv[index + 1];
    fs.cpSync('public/_cognia/builtin-plugins', path.join(out, '_cognia/builtin-plugins'), {recursive:true});
    fs.mkdirSync(path.join(out, 'chunks'), {recursive:true});
    fs.mkdirSync(path.join(out, 'sidecar'), {recursive:true});
    fs.writeFileSync(path.join(out, 'cognia-agent.mjs'), 'import { value } from "./chunks/value.mjs"; console.log(value)');
    fs.writeFileSync(path.join(out, 'chunks/value.mjs'), 'export const value = "artifact-ok"');
    fs.writeFileSync(path.join(out, 'sidecar/ast-grep'), '#!/bin/sh\\necho ast-ok\\n', {mode:0o755});
    const inputsIndex = process.argv.indexOf('--inputs-file');
    if (inputsIndex >= 0) fs.writeFileSync(process.argv[inputsIndex+1], JSON.stringify([
      path.resolve('scripts/build/build-cli.mjs'), path.resolve('public/_cognia/builtin-plugins/fixture.cjs')
    ]));
    fs.appendFileSync('build-count', 'build\\n');
  `
  )
  git("add", ".")
  git("commit", "--quiet", "-m", "fixture")
  const head = git("rev-parse", "HEAD")
  fs.mkdirSync(path.join(root, ".cache/jest"), { recursive: true })
  const plan = { head, testFiles: [suite], shards: [{ shard: 1, testFiles: [suite] }] }
  fs.writeFileSync(path.join(root, ".cache/jest/plan.json"), JSON.stringify(plan))
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [driver, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_SHA: head,
        GITHUB_OUTPUT: "",
        COGNIA_JEST_CLI_BUNDLE: "",
        ...env,
      },
    })
  return { root, head, git, plan, run }
}

function succeeds(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

test("two test consumers reuse one exact-SHA bundle after an artifact transfer", (t) => {
  const f = fixture(t)
  succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
  assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\n")
  assert.equal(
    fs.existsSync(path.join(f.root, "cli/dist")),
    false,
    "producer uses an isolated output"
  )
  succeeds(f.run(["restore", ".cache/jest/plan.json", "1"]))
  for (let consumer = 0; consumer < 2; consumer++) {
    succeeds(f.run(["ensure"], { COGNIA_JEST_CLI_BUNDLE: manifestPath }))
    assert.equal(
      execFileSync(process.execPath, ["cli/dist/cognia-agent.mjs"], {
        cwd: f.root,
        encoding: "utf8",
      }).trim(),
      "artifact-ok"
    )
  }
  assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\n")
  assert.ok(fs.statSync(path.join(f.root, "cli/dist/sidecar/ast-grep")).mode & 0o111)
  assert.equal(fs.readFileSync(path.join(f.root, "plugin-build-count"), "utf8"), "build\n")
  assert.equal(
    fs.readFileSync(path.join(f.root, "cli/dist/_cognia/builtin-plugins/fixture.cjs"), "utf8"),
    'module.exports = "plugin-ok"'
  )
})

test("artifact reuse survives a different checkout path at the same commit", (t) => {
  const f = fixture(t)
  succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "jest-cli-consumer-"))
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }))
  execFileSync("git", ["clone", "--quiet", f.root, consumer])
  fs.cpSync(path.join(f.root, ".cache"), path.join(consumer, ".cache"), { recursive: true })
  for (const args of [["restore", ".cache/jest/plan.json", "1"], ["ensure"], ["ensure"]]) {
    succeeds(
      spawnSync(process.execPath, [driver, ...args], {
        cwd: consumer,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_SHA: f.head,
          GITHUB_OUTPUT: "",
          COGNIA_JEST_CLI_BUNDLE: manifestPath,
        },
      })
    )
  }
  assert.equal(fs.existsSync(path.join(consumer, "build-count")), false)
  assert.equal(fs.existsSync(path.join(consumer, "plugin-build-count")), false)
})

test("unselected plans and shards do not require or build a CLI artifact", (t) => {
  const f = fixture(t)
  const unselected = {
    ...f.plan,
    testFiles: ["lib/utils.test.ts"],
    shards: [{ shard: 1, testFiles: ["lib/utils.test.ts"] }],
  }
  fs.writeFileSync(path.join(f.root, ".cache/jest/plan.json"), JSON.stringify(unselected))
  succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
  succeeds(f.run(["restore", ".cache/jest/plan.json", "1"]))
  assert.equal(fs.existsSync(path.join(f.root, "build-count")), false)
  assert.equal(fs.existsSync(path.join(f.root, "plugin-build-count")), false)
  const unknown = f.run(["restore", ".cache/jest/plan.json", "2"])
  assert.notEqual(unknown.status, 0)
})

test("workflow outputs publish a bundle only when selected and download it only in relevant shards", (t) => {
  const f = fixture(t)
  const output = path.join(f.root, ".cache/jest/outputs")
  const env = { GITHUB_OUTPUT: output }
  const plan = {
    ...f.plan,
    shards: [
      { shard: 1, testFiles: [suite] },
      { shard: 2, testFiles: ["cli/src/cli/coding-loop.bundle.test.ts"] },
      { shard: 3, testFiles: ["lib/utils.test.ts"] },
    ],
  }
  fs.writeFileSync(path.join(f.root, ".cache/jest/plan.json"), JSON.stringify(plan))
  succeeds(f.run(["prepare", ".cache/jest/plan.json"], env))
  for (const shard of ["1", "2", "3"])
    succeeds(f.run(["required", ".cache/jest/plan.json", shard], env))
  assert.equal(
    fs.readFileSync(output, "utf8"),
    "prepared=true\nrequired=true\nrequired=true\nrequired=false\n"
  )
})

test("local ensure builds current sources even if an old artifact manifest is present", (t) => {
  const f = fixture(t)
  succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
  const builder = path.join(f.root, "scripts/build/build-cli.mjs")
  fs.appendFileSync(builder, "\n// local edit at the same SHA\n")
  succeeds(f.run(["ensure"]))
  assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\nbuild\n")
})

test("producer rejects dirty sources and stale plans before invoking the build", (t) => {
  const f = fixture(t)
  fs.writeFileSync(
    path.join(f.root, ".cache/jest/plan.json"),
    JSON.stringify({ ...f.plan, head: "a".repeat(40) })
  )
  assert.notEqual(f.run(["prepare", ".cache/jest/plan.json"]).status, 0)
  fs.writeFileSync(path.join(f.root, ".cache/jest/plan.json"), JSON.stringify(f.plan))
  fs.appendFileSync(path.join(f.root, "scripts/build/build-cli.mjs"), "\n// dirty\n")
  assert.notEqual(f.run(["prepare", ".cache/jest/plan.json"]).status, 0)
  assert.equal(fs.existsSync(path.join(f.root, "build-count")), false)
})

for (const field of ["version", "head", "platform", "arch", "nodeMajor"]) {
  test(`restore rejects a mismatched artifact ${field} without rebuilding`, (t) => {
    const f = fixture(t)
    succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
    const file = path.join(f.root, manifestPath)
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest[field] = "wrong"
    fs.writeFileSync(file, JSON.stringify(manifest))
    const result = f.run(["restore", ".cache/jest/plan.json", "1"])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`CLI bundle ${field} differs`))
    assert.equal(fs.existsSync(path.join(f.root, "cli/dist")), false)
    assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\n")
  })
}

test("restore rejects a damaged tar before changing the output directory", (t) => {
  const f = fixture(t)
  succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
  fs.appendFileSync(path.join(f.root, ".cache/jest/cli-bundle.tar"), "damage")
  const result = f.run(["restore", ".cache/jest/plan.json", "1"])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /archive digest mismatch/)
  assert.equal(fs.existsSync(path.join(f.root, "cli/dist")), false)
})

for (const damage of ["changed", "missing", "extra", "mode", "manifest"]) {
  test(`consumer fails closed on ${damage} artifact data instead of silently rebuilding`, (t) => {
    const f = fixture(t)
    succeeds(f.run(["prepare", ".cache/jest/plan.json"]))
    succeeds(f.run(["restore", ".cache/jest/plan.json", "1"]))
    const chunk = path.join(f.root, "cli/dist/chunks/value.mjs")
    if (damage === "changed") fs.appendFileSync(chunk, "\n// damage")
    if (damage === "missing") fs.rmSync(chunk)
    if (damage === "extra")
      fs.writeFileSync(path.join(f.root, "cli/dist/chunks/stale.mjs"), "stale")
    if (damage === "mode") fs.chmodSync(path.join(f.root, "cli/dist/sidecar/ast-grep"), 0o644)
    if (damage === "manifest") fs.rmSync(path.join(f.root, manifestPath))
    assert.notEqual(f.run(["ensure"], { COGNIA_JEST_CLI_BUNDLE: manifestPath }).status, 0)
    assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\n")
  })
}

test("plugin prerequisite failure stops preparation before building or publishing the CLI", (t) => {
  const f = fixture(t)
  const result = f.run(["prepare", ".cache/jest/plan.json"], { FIXTURE_PLUGIN_BUILD_FAIL: "1" })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /plugin build failed/)
  assert.equal(fs.existsSync(path.join(f.root, "build-count")), false)
  assert.equal(fs.existsSync(path.join(f.root, manifestPath)), false)
  assert.equal(fs.existsSync(path.join(f.root, ".cache/jest/cli-bundle.tar")), false)
})

function ensuredPath(result) {
  succeeds(result)
  return result.stdout.trim().split("\n").at(-1)
}

test("local suites reuse current source fingerprints in isolated outputs", (t) => {
  const f = fixture(t)
  const first = ensuredPath(f.run(["ensure"]))
  const second = ensuredPath(f.run(["ensure"]))
  assert.equal(first, second)
  assert.equal(execFileSync(process.execPath, [second], { encoding: "utf8" }).trim(), "artifact-ok")
  assert.equal(fs.existsSync(path.join(f.root, "cli/dist")), false)
  assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\n")
  fs.appendFileSync(path.join(f.root, "scripts/build/build-cli.mjs"), "\n// current source edit\n")
  const third = ensuredPath(f.run(["ensure"]))
  assert.notEqual(third, first)
  assert.equal(fs.existsSync(first), true, "active readers keep their original chunks")
  assert.equal(fs.readFileSync(path.join(f.root, "build-count"), "utf8"), "build\nbuild\n")
  assert.ok(fs.statSync(path.join(path.dirname(third), "sidecar/ast-grep")).mode & 0o111)
})
