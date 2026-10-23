// Real project contracts live separately from PTY observation helpers: these
// independent checks execute generated applications, never trust model reports.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"

/** Non-overlapping real-source excerpts; never clamp and repeat a file's last page. */
export function researchSourcePages(repo, count, pageLines = 250) {
  const directories = [
    "cli/src/agent",
    "cli/src/tui/runtime",
    "cli/src/config",
    "sidecar/src/context",
    "sidecar/src/runtimes/ai-sdk",
  ]
  const files = directories
    .flatMap((dir) =>
      fs
        .readdirSync(path.join(repo, dir), { recursive: true })
        .filter((name) => name.endsWith(".ts") && !/\.(?:test|d)\.ts$/.test(name))
        .map((name) => path.join(dir, name))
    )
    .sort()
  const sources = files.map((file) => ({
    file,
    lines: fs.readFileSync(path.join(repo, file), "utf8").split("\n"),
  }))
  const pages = []
  const hashes = new Set()
  for (let offset = 0; pages.length < count; offset += pageLines) {
    let available = false
    for (const source of sources) {
      const lines = source.lines.slice(offset, offset + pageLines)
      if (lines.length < Math.min(100, pageLines)) continue
      available = true
      const code = lines.join("\n")
      const hash = createHash("sha256").update(code).digest("hex")
      if (hashes.has(hash)) continue
      hashes.add(hash)
      pages.push({
        source: source.file,
        start: offset + 1,
        code,
        codeHash: hash,
        lineCount: lines.length,
      })
      if (pages.length === count) break
    }
    assert.ok(available, "not enough distinct real-source ranges for the requested corpus")
  }
  return pages
}

export function projectEnv(root, extra = {}, source = process.env) {
  const home = path.join(root, "os-home")
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  return {
    ...Object.fromEntries(
      ["PATH", "TMPDIR", "SystemRoot", "ComSpec"]
        .filter((k) => source[k])
        .map((k) => [k, source[k]])
    ),
    HOME: home,
    USERPROFILE: home,
    LANG: "en_US.UTF-8",
    ...extra,
  }
}

export function projectSnapshot(workspace) {
  const files = {}
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(workspace, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile())
        files[name] = createHash("sha256")
          .update(fs.readFileSync(path.join(workspace, name)))
          .digest("hex")
    }
  }
  visit("")
  return files
}

export const INVENTORY_V1 = `# Warehouse Ledger
Build a usable dependency-free Node.js ESM inventory CLI with README, package.json,
src/cli.mjs, implementation modules and node:test tests. npm test must run tests.
Do not modify requirements.md or customer-note.txt. No installs or external services.
Public CLI: node src/cli.mjs --db <json-file> <command> [...args].
- add <sku> <name>: create stock 0, reject duplicate SKU.
- receive <sku> <qty>: add a positive safe integer quantity.
- ship <sku> <qty>: subtract a positive safe integer; reject insufficient stock.
- list: stdout JSON array of {sku,name,stock}, sorted by SKU.
- export: stdout RFC4180 CSV with header sku,name,stock, proper quotes and Unicode.
Successful mutations print the item as JSON. Failures use nonzero exit and a JSON
{error: string} on stderr; no state change. Reject unknown SKU, missing/blank
names, noninteger/nonpositive/unsafe quantities, overflow and malformed DB JSON.
Persist across separate CLI invocations using atomic file replacement. Create
missing parent directories. No network. Use actual tests for business invariants.
`

export const INVENTORY_V2 = `\n# Version 2 follow-up: transactional CSV import
Add import <csv-file> to the existing CLI. Header is sku,name,stock; support CRLF,
quoted commas, doubled quotes, Unicode and a missing final newline. Parse and
validate the entire file before any mutation: SKU/name nonblank, stock a
nonnegative safe integer, no duplicate SKU in the import, exactly three fields.
Upsert stock/name by SKU; repeated identical import is idempotent. Print JSON
{imported: <row count>}. Invalid input rejects with nonzero exit and {error} on
stderr while leaving database bytes unchanged. Preserve all V1 behavior.
`

export const TASKBOARD_REQUIREMENTS = `# Local Task Board
Implement a real dependency-free Node.js ESM task board: src/server.mjs,
public/index.html, public/app.js, public/style.css, package.json, node:test tests
and README. npm test runs tests. Preserve requirements.md and customer-note.txt.
Run node src/server.mjs; bind 127.0.0.1, PORT env (including 0), DATA_FILE env.
After listening print READY http://127.0.0.1:<actual-port>. Default PORT 3210.
Persist tasks atomically to DATA_FILE (default .data/tasks.json), creating parent
directories. Serialize concurrent mutations. Restart must retain tasks.
API responses are JSON, errors {error: string}:
- GET /api/tasks -> array; filter case-insensitive substring q and exact status.
- POST /api/tasks {title} -> 201 {id,title,status:'todo',version:1}.
- PATCH /api/tasks/:id {version, title?, status?} -> 200 updated task; version
  required and must match current version (409 stale). Increment once per update.
- DELETE /api/tasks/:id -> 200 {deleted:true}. Unknown IDs 404.
Trim titles; reject blank/nonstring/>120 chars, bad status, malformed JSON (400).
Statuses todo, doing, done. Updates may change title, status or both.
Serve only the public app assets; never expose source, data or parent paths.
UI must work without build/install: accessible labels Title and Search tasks,
button Add task, select Status filter, per-task status select labelled
'Status for <title>', delete button labelled 'Delete <title>'. List existing
tasks on load; add, update status, delete, filter; show useful errors and pending
state. Render user titles as text (no innerHTML). Keyboard and narrow-screen
usable. Include a cohesive simple visual design and useful README commands.
Do not start a persistent server from the model turn; run finite tests only.
`

export function assertItem(value, sku, name, stock) {
  assert.equal(value.sku, sku)
  assert.equal(value.name, name)
  assert.equal(value.stock, stock)
  assert.ok(Number.isSafeInteger(value.stock) && value.stock >= 0)
}

export function verifyInventory(workspace, evidenceRoot, { v2 = false } = {}) {
  const dir = fs.mkdtempSync(
    path.join(evidenceRoot, v2 ? "inventory-v2-data-" : "inventory-v1-data-")
  )
  let cliInvocations = 0
  const db = path.join(dir, "nested", "stock.json")
  const run = (args, { ok = true, dataFile = db } = {}) => {
    const r = spawnSync(process.execPath, ["src/cli.mjs", "--db", dataFile, ...args], {
      cwd: workspace,
      env: projectEnv(evidenceRoot),
      encoding: "utf8",
      timeout: 15_000,
    })
    assert.ifError(r.error)
    cliInvocations++
    if (ok) assert.equal(r.status, 0, r.stderr)
    else {
      assert.notEqual(r.status, 0, "invalid operation must fail")
      assert.equal(typeof JSON.parse(r.stderr).error, "string")
    }
    return r.stdout
  }
  assertItem(JSON.parse(run(["add", "A-01", 'Blue, "large"'])), "A-01", 'Blue, "large"', 0)
  assertItem(JSON.parse(run(["add", "B-02", "陶瓷杯"])), "B-02", "陶瓷杯", 0)
  assertItem(JSON.parse(run(["receive", "A-01", "12"])), "A-01", 'Blue, "large"', 12)
  assertItem(JSON.parse(run(["ship", "A-01", "5"])), "A-01", 'Blue, "large"', 7)
  const before = fs.readFileSync(db)
  for (const args of [
    ["ship", "A-01", "8"],
    ["receive", "A-01", "-1"],
    ["receive", "A-01", "1.5"],
    ["receive", "A-01", "9007199254740992"],
    ["receive", "missing", "1"],
    ["add", "A-01", "duplicate"],
    ["add", "C-03", "   "],
  ]) {
    run(args, { ok: false })
    assert.deepEqual(fs.readFileSync(db), before, `failed ${args[0]} must not mutate state`)
  }
  const list = JSON.parse(run(["list"]))
  assert.equal(list.length, 2)
  assertItem(list[0], "A-01", 'Blue, "large"', 7)
  assertItem(list[1], "B-02", "陶瓷杯", 0)
  const csv = run(["export"]).replaceAll("\r\n", "\n")
  assert.equal(csv.trimEnd(), 'sku,name,stock\nA-01,"Blue, ""large""",7\nB-02,陶瓷杯,0')
  const corrupt = path.join(dir, "corrupt.json")
  fs.writeFileSync(corrupt, "{broken")
  run(["list"], { ok: false, dataFile: corrupt })
  assert.equal(fs.readFileSync(corrupt, "utf8"), "{broken")
  if (v2) {
    const imported = path.join(dir, "import.csv")
    fs.writeFileSync(imported, 'sku,name,stock\r\nA-01,"Updated, ""quoted""",9\r\nC-03,新货品,4')
    assert.equal(JSON.parse(run(["import", imported])).imported, 2)
    const first = run(["list"])
    assert.equal(JSON.parse(run(["import", imported])).imported, 2)
    assert.equal(run(["list"]), first)
    const items = JSON.parse(first)
    assert.equal(items.length, 3)
    assertItem(items[0], "A-01", 'Updated, "quoted"', 9)
    assertItem(items[2], "C-03", "新货品", 4)
    const unchanged = fs.readFileSync(db)
    for (const invalid of [
      "sku,name,stock\nD-04,valid,3\nE-05,bad,-1",
      "sku,name,stock\nD-04,valid,3\nD-04,duplicate,2",
      'sku,name,stock\nD-04,"unterminated,3',
      "sku,name,stock\nD-04,valid,1.5",
    ]) {
      fs.writeFileSync(imported, invalid)
      run(["import", imported], { ok: false })
      assert.deepEqual(fs.readFileSync(db), unchanged)
    }
  }
  return {
    cliInvocations,
    persistedItems: v2 ? 3 : 2,
    csvQuotesAndUnicode: true,
    rejectedWritesUnchanged: true,
  }
}

export async function startTaskboard(workspace, dataFile, logFile, redact) {
  assert.equal(typeof redact, "function", "artifact redactor required")
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: workspace,
    env: projectEnv(path.dirname(logFile), { PORT: "0", DATA_FILE: dataFile }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let logText = ""
  const log = (b) => {
    logText = (logText + b.toString()).slice(-1024 * 1024)
    fs.writeFileSync(logFile, redact(logText), { mode: 0o600 })
  }
  child.stdout.on("data", (b) => {
    output += b
    log(b)
  })
  child.stderr.on("data", log)
  let stopped
  const stop = () =>
    (stopped ??= new Promise((resolve, reject) => {
      if (child.exitCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(Error("project server failed to stop"))
      }, 3_000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill("SIGTERM")
    }))
  const deadline = Date.now() + 10_000
  while (!/READY (http:\/\/127\.0\.0\.1:\d+)/.test(output)) {
    if (child.exitCode !== null || Date.now() >= deadline) {
      await stop()
      throw Error(`project server did not publish READY: ${output.slice(-500)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { url: output.match(/READY (http:\/\/127\.0\.0\.1:\d+)/)[1], stop, pid: child.pid }
}

export async function verifyTaskboard(workspace, root, redact) {
  const dataFile = path.join(fs.mkdtempSync(path.join(root, "taskboard-data-")), "tasks.json")
  let server = await startTaskboard(
    workspace,
    dataFile,
    path.join(root, "taskboard-api-server.log"),
    redact
  )
  let checks = 0
  const request = async (route, { method = "GET", body, expected = 200 } = {}) => {
    const response = await fetch(server.url + route, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, expected, `${method} ${route}`)
    checks++
    return response.json()
  }
  try {
    assert.deepEqual(await request("/api/tasks"), [])
    const a = await request("/api/tasks", {
      method: "POST",
      body: { title: "  Pack orders  " },
      expected: 201,
    })
    assert.equal(a.title, "Pack orders")
    assert.equal(a.status, "todo")
    assert.equal(a.version, 1)
    const b = await request("/api/tasks", {
      method: "POST",
      body: { title: "<img src=x onerror=alert(1)>" },
      expected: 201,
    })
    assert.notEqual(String(a.id), String(b.id))
    const changed = await request(`/api/tasks/${a.id}`, {
      method: "PATCH",
      body: { version: 1, status: "doing" },
    })
    assert.equal(changed.version, 2)
    assert.equal(changed.status, "doing")
    await request(`/api/tasks/${a.id}`, {
      method: "PATCH",
      body: { version: 1, title: "stale" },
      expected: 409,
    })
    for (const body of [{ title: " " }, { title: 42 }, { title: "x".repeat(121) }, "{"])
      await request("/api/tasks", { method: "POST", body, expected: 400 })
    await request(`/api/tasks/${a.id}`, {
      method: "PATCH",
      body: { version: 2, status: "invalid" },
      expected: 400,
    })
    assert.equal((await request("/api/tasks?q=PACK&status=doing")).length, 1)
    await request("/api/tasks/not-found", { method: "DELETE", expected: 404 })
    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        request("/api/tasks", { method: "POST", body: { title: `Batch ${i}` }, expected: 201 })
      )
    )
    assert.equal(new Set(concurrent.map((t) => String(t.id))).size, 12)
    assert.equal((await request("/api/tasks")).length, 14)
    assert.equal((await request(`/api/tasks/${b.id}`, { method: "DELETE" })).deleted, true)
    await server.stop()
    server = await startTaskboard(
      workspace,
      dataFile,
      path.join(root, "taskboard-restart-server.log"),
      redact
    )
    const retained = await request("/api/tasks")
    assert.equal(retained.length, 13)
    assert.equal(retained.find((t) => String(t.id) === String(a.id)).status, "doing")
    for (const route of ["/src/server.mjs", "/requirements.md", "/%2e%2e/requirements.md"]) {
      const response = await fetch(server.url + route, { signal: AbortSignal.timeout(5_000) })
      assert.equal(response.status, 404)
      await response.arrayBuffer()
      checks++
    }
    assert.match(
      await (await fetch(server.url, { signal: AbortSignal.timeout(5_000) })).text(),
      /<html/i
    )
    checks++
    return { checks, concurrentCreates: 12, retainedAfterRestart: 13, staleUpdateRejected: true }
  } finally {
    await server.stop()
  }
}
