import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  assertItem,
  projectEnv,
  projectSnapshot,
  startTaskboard,
  researchSourcePages,
} from "./tui-project-acceptance.mjs"

test("research corpus contains distinct payloads and non-overlapping original source lines", () => {
  const repo = path.resolve(import.meta.dirname, "../..")
  const pages = researchSourcePages(repo, 38)
  assert.equal(pages.length, 38)
  assert.equal(new Set(pages.map((page) => page.codeHash)).size, 38)
  const ranges = new Set()
  for (const page of pages) {
    for (let line = page.start; line < page.start + page.lineCount; line++) {
      const key = `${page.source}:${line}`
      assert.ok(!ranges.has(key), `repeated source line ${key}`)
      ranges.add(key)
    }
  }
})

test("independent inventory checks require exact persisted values", () => {
  assertItem({ sku: "A", name: "杯子", stock: 4 }, "A", "杯子", 4)
  assert.throws(() => assertItem({ sku: "A", name: "杯子", stock: 3 }, "A", "杯子", 4))
  assert.throws(() => assertItem({ sku: "B", name: "杯子", stock: 4 }, "A", "杯子", 4))
})

test("independent inventory checks reject unsafe or invalid stock even if expected", () => {
  for (const stock of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => assertItem({ sku: "A", name: "Cup", stock }, "A", "Cup", stock))
  }
})

test("generated projects receive an isolated home and no provider credentials", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-project-env-"))
  try {
    const env = projectEnv(
      root,
      { PORT: "0" },
      {
        PATH: "/bin",
        HOME: "/real-home",
        COGNIA_API_KEY: "private-key",
        AWS_SECRET_ACCESS_KEY: "private-cloud-key",
        NODE_OPTIONS: "--require=untrusted",
      }
    )
    assert.deepEqual(env, {
      PATH: "/bin",
      HOME: path.join(root, "os-home"),
      USERPROFILE: path.join(root, "os-home"),
      LANG: "en_US.UTF-8",
      PORT: "0",
    })
    assert.ok(fs.statSync(env.HOME).isDirectory())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("read-only planning evidence detects nested file changes, additions and removals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-project-snapshot-"))
  try {
    fs.mkdirSync(path.join(root, "tests"))
    fs.mkdirSync(path.join(root, ".git"))
    fs.writeFileSync(path.join(root, "tests/stock.test.mjs"), "original")
    const before = projectSnapshot(root)
    fs.writeFileSync(path.join(root, ".git/index"), "git metadata")
    assert.deepEqual(projectSnapshot(root), before)
    fs.writeFileSync(path.join(root, "tests/stock.test.mjs"), "changed")
    assert.notDeepEqual(projectSnapshot(root), before)
    fs.writeFileSync(path.join(root, "tests/stock.test.mjs"), "original")
    fs.writeFileSync(path.join(root, "tests/new.test.mjs"), "added")
    assert.notDeepEqual(projectSnapshot(root), before)
    fs.rmSync(path.join(root, "tests/new.test.mjs"))
    fs.rmSync(path.join(root, "tests/stock.test.mjs"))
    assert.notDeepEqual(projectSnapshot(root), before)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("server evidence redacts a secret split across output chunks and awaits cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-project-log-"))
  let server
  try {
    fs.mkdirSync(path.join(root, "src"))
    fs.writeFileSync(
      path.join(root, "src/server.mjs"),
      `
      import http from "node:http";
      const server = http.createServer((_, res) => res.end("OK"));
      server.listen(0, "127.0.0.1", () => {
        console.log("READY http://127.0.0.1:" + server.address().port);
        process.stdout.write("private-");
        setTimeout(() => process.stdout.write("fixture-key"), 50);
      });
      process.on("SIGTERM", () => server.close());
    `
    )
    const log = path.join(root, "server.log")
    server = await startTaskboard(root, path.join(root, "data.json"), log, (value) =>
      value.replaceAll("private-fixture-key", "[REDACTED]")
    )
    const deadline = Date.now() + 3000
    while (!fs.readFileSync(log, "utf8").includes("[REDACTED]")) {
      assert.ok(Date.now() < deadline, "split output was not redacted")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(!fs.readFileSync(log, "utf8").includes("private-fixture-key"))
    await server.stop()
    server = undefined
  } finally {
    await server?.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
