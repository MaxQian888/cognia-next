#!/usr/bin/env node
// Real-webview acceptance; a local fixture avoids business/provider side effects.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"
import { once } from "node:events"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { connectTauriSession, expect as tauriExpect } from "./agent-debug-client.mjs"
import { loadEndpoint, request } from "./agent-debug.mjs"

const fixture = `<!doctype html><meta charset="utf-8"><title>Debug concurrency acceptance</title>
<style>body{font:20px system-ui;padding:40px;background:#f8fafc;color:#0f172a}button,input{font:inherit;margin:12px;padding:12px}</style>
<h1>Tauri multi-client acceptance</h1><output id="frames" style="position:fixed;right:8px;top:8px;font-size:12px">0</output><label for="message">Message</label><input id="message">
<output id="input-events" style="position:fixed;right:8px;top:25px">0</output><output id="chords" style="position:fixed;right:8px;top:42px">0</output>
<button id="count">Count</button><output id="result" aria-label="Count result">0</output>
<button id="oversize">Oversize metadata</button><button id="clear-metadata">Clear metadata</button>
<button id="slow">Slow frames</button><button id="fast">Fast frames</button><button id="navigate">SPA navigation</button>
<script>
let inputEvents=0,chords=0;document.querySelector('#message').addEventListener('input',()=>document.querySelector('#input-events').textContent=String(++inputEvents));document.querySelector('#message').addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='a')document.querySelector('#chords').textContent=String(++chords)});
let count=0, slow=false;const raf=window.requestAnimationFrame.bind(window);
let frames=0;raf(function frame(){document.querySelector('#frames').textContent=String(++frames);raf(frame)});
window.requestAnimationFrame=callback=>slow?setTimeout(()=>raf(callback),200):raf(callback);
document.querySelector('#oversize').onclick=()=>{const node=document.createElement('p');node.id='oversized';node.setAttribute('role','button');node.setAttribute('aria-label','x'.repeat(3*1024*1024));node.textContent='Large metadata';document.body.append(node)};document.querySelector('#clear-metadata').onclick=()=>document.querySelector('#oversized')?.remove();
const message=document.querySelector('#message'),originalAttribute=message.getAttribute.bind(message);message.getAttribute=name=>name==='data-boundary'?fetch('/read-gate').then(response=>response.text()):originalAttribute(name);
document.querySelector('#count').onclick=()=>document.querySelector('#result').textContent=String(++count);
document.querySelector('#slow').onclick=()=>slow=true;document.querySelector('#fast').onclick=()=>slow=false;
document.querySelector('#navigate').onclick=()=>history.pushState({},'',location.pathname+'?done=1');
</script>`
const outputDir = path.resolve(
  process.argv[2] ||
    `.cache/tauri-agent-debug/concurrency-${new Date().toISOString().replace(/[:.]/g, "-")}`
)
await fs.mkdir(outputDir, { recursive: true })
const endpoint = loadEndpoint()
const sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      "src-tauri/src/agent_debug.rs",
      "src-tauri/src/agent_debug/sessions.rs",
      "src-tauri/src/agent_debug/injected.js",
      "src-tauri/src/cli_bridge/server.rs",
      "crates/cognia-companion-security/src/idempotency.rs",
      "scripts/tauri/agent-debug-client.mjs",
    ].map(async (file) => [
      file,
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    ])
  )
)
const health = await request("/api/dev/agent/health", { endpoint })
assert.equal(health.agentDebug, true)
assert.equal(health.sharedMode, true, "launch an owned --shared --no-watch run first")
assert.equal(health.helper?.version, 3)
assert.equal(health.helper?.revision, 7)
assert.equal(health.helper?.capabilities?.appWriterLease, 1)
assert.equal(health.helper?.capabilities?.atomicInput, 1)
let holdReloads = false
let streamLoading = false
const pendingResponses = new Set()
const pendingReadResponses = new Set()
let readArrivals = 0
const sendFixture = (response) => {
  if (response.destroyed) return
  if (!response.headersSent)
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    })
  response.end(fixture)
}
const server = http.createServer((req, response) => {
  if (req.url.startsWith("/read-gate")) {
    readArrivals++
    pendingReadResponses.add(response)
    response.on("close", () => pendingReadResponses.delete(response))
    return
  }
  if (holdReloads) {
    pendingResponses.add(response)
    response.on("close", () => pendingResponses.delete(response))
    if (streamLoading) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      })
      response.write("<!doctype html><title>Loading barrier</title>")
    }
  } else sendFixture(response)
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const fixtureUrl = `http://127.0.0.1:${server.address().port}/`
const clients = []
const steps = []
// Credentials travel over IPC; a worker receives only its scoped descriptor.
const runClientProcess = (session, action) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    const { TauriClientSession } = await import(process.argv[1]);
    process.once('message', async ({descriptor, action}) => {
      try {
        const client = new TauriClientSession(descriptor);
        let result;
        if (action === 'observe') result = {value: await client.page().getByLabel('Message').inputValue()};
        else {
          try { await client.page().getByLabel('Message').fill('wrong'); throw new Error('unexpected writer admission'); }
          catch (error) { if(error.code !== 'writer_busy') throw error; result = {code:error.code}; }
        }
        process.send({ok:true, pid:process.pid, ...result});
      } catch(error) { process.send({ok:false, error:error.message}); }
      process.disconnect();
    });
    process.send({ready:true});
  `,
        new URL("./agent-debug-client.mjs", import.meta.url).href,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] }
    )
    let result
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("scoped worker timed out"))
    }, 15_000)
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096)
    })
    child.on("message", (message) => {
      if (message.ready)
        child.send({
          descriptor: {
            endpoint: session.endpoint,
            clientSessionId: session.clientSessionId,
            windows: session.windows,
            canWrite: session.canWrite,
          },
          action,
        })
      else result = message
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      if (code !== 0 || !result?.ok)
        reject(new Error(result?.error || stderr || `worker exited ${code}`))
      else resolve(result)
    })
  })
const step = async (name, callback) => {
  const start = performance.now()
  const detail = await callback()
  steps.push({ name, elapsedMs: Math.round(performance.now() - start), detail: detail ?? null })
  console.log(`PASS ${name}`)
}
const cli = (args, success = true) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [new URL("./agent-debug.mjs", import.meta.url).pathname, ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("exit", (code) => {
      try {
        const result = JSON.parse(success ? stdout : stderr)
        assert.equal(code === 0, success, stderr)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    })
  })
let failed
try {
  const a = await connectTauriSession({ endpoint, canWrite: true })
  clients.push(a)
  const b = await connectTauriSession({ endpoint, canWrite: true })
  clients.push(b)
  const observer = await connectTauriSession({ endpoint })
  clients.push(observer)
  const pageA = a.page(),
    pageB = b.page()
  assert.equal(
    (await a.status()).control.quarantined,
    false,
    "a controlled owner restart clears unknown execution state"
  )
  await step("real app main UI and cross-window app writer", async () => {
    const snapshot = await pageA.snapshot({ includeText: true })
    assert(snapshot.nodes.length > 0, "real app UI has semantic content")
    await fs.writeFile(
      path.join(outputDir, "business-ui-snapshot.json"),
      JSON.stringify(snapshot, null, 2)
    )
    const windows = (await request("/api/dev/agent/windows", { endpoint })).windows
    const other = windows.find((window) => window.label !== "main")
    assert(other, "a second real Tauri window must exist for cross-window acceptance")
    const multi = await connectTauriSession({ endpoint, windows: [other.label], canWrite: true })
    clients.push(multi)
    await multi.page().waitForRenderer({ timeout: 30_000 })
    const otherSnapshot = await multi.page().snapshot({ includeText: true })
    await a.acquireWriter()
    await assert.rejects(multi.acquireWriter(), (error) => error.code === "writer_busy")
    await a.releaseWriter()
    await multi.acquireWriter()
    await multi.releaseWriter()
    await multi.detach()
    return {
      mainNodes: snapshot.nodes.length,
      otherWindow: other.label,
      otherNodes: otherSnapshot.nodes.length,
    }
  })
  await pageA.goto(fixtureUrl)
  const frameStart = await pageB.locator("#frames").textContent()
  await tauriExpect(pageB.locator("#frames")).not.toHaveText(frameStart, { timeout: 5000 })
  const frameEnd = await pageB.locator("#frames").textContent()
  await fs.writeFile(
    path.join(outputDir, "frame-readiness.json"),
    JSON.stringify(
      {
        before: frameStart,
        after: frameEnd,
        windows: (await request("/api/dev/agent/windows", { endpoint })).windows,
      },
      null,
      2
    )
  )
  assert(
    Number(frameEnd) > Number(frameStart),
    "real WKWebView animation frames must advance before stability-based actions"
  )
  const textbox = (snapshot) =>
    snapshot.nodes.find((node) => node.role === "textbox" && node.name === "Message").ref
  await step(
    "outer workflow cancellation prevents later child input and permits handoff",
    async () => {
      const controller = new AbortController()
      let enter, resume
      const entered = new Promise((resolve) => {
        enter = resolve
      })
      const gate = new Promise((resolve) => {
        resume = resolve
      })
      const work = a.withWriter(
        async () => {
          enter()
          await gate
          await pageA.getByLabel("Message").fill("must-not-write")
        },
        { signal: controller.signal }
      )
      await entered
      controller.abort(new Error("cancel workflow"))
      resume()
      await assert.rejects(work, /cancel workflow/)
      assert.equal(await pageB.getByLabel("Message").inputValue(), "")
      await b.acquireWriter()
      await b.releaseWriter()
      return { lateInputs: 0, writerHandedOff: true }
    }
  )
  await step("terminal snapshot error permits held-key cleanup and another snapshot", async () => {
    await a.acquireWriter()
    await pageA.keyboard.down("Control")
    assert((await pageA._typedHelper("health")).heldInput > 0)
    await assert.rejects(
      pageA.snapshot({ selector: "[" }),
      (error) => error.code === "webview_eval_rejected"
    )
    assert((await pageA.snapshot()).nodes.length > 0)
    await pageA
      .getByRole("button", { name: "Oversize metadata", exact: true })
      .click({ force: true })
    await assert.rejects(pageA.snapshot(), (error) => error.code === "webview_eval_rejected")
    await pageA.getByRole("button", { name: "Clear metadata", exact: true }).click({ force: true })
    assert((await pageA.snapshot()).nodes.length > 0)
    await a.releaseWriter()
    await b.acquireWriter()
    assert.equal((await pageB._typedHelper("health")).heldInput, 0)
    await b.releaseWriter()
    return { snapshotRetried: true, heldInput: 0, writerHandedOff: true }
  })
  await step(
    "complete delayed text and keyboard chords replay once and reject changed arguments",
    async () => {
      await a.acquireWriter()
      const options = { delay: 5, operationId: randomUUID() }
      const before = Number(await pageB.locator("#input-events").textContent())
      await pageA.getByLabel("Message").pressSequentially("aa", options)
      await pageA.getByLabel("Message").pressSequentially("aa", options)
      await assert.rejects(
        pageA.getByLabel("Message").pressSequentially("ab", options),
        (error) => error.code === "operation_conflict"
      )
      assert.equal(await pageB.getByLabel("Message").inputValue(), "aa")
      assert.equal(Number(await pageB.locator("#input-events").textContent()), before + 2)
      const keyboardOptions = { delay: 5, operationId: randomUUID() }
      await pageA.keyboard.type("ab", keyboardOptions)
      await pageA.keyboard.type("ab", keyboardOptions)
      await assert.rejects(
        pageA.keyboard.type("ac", keyboardOptions),
        (error) => error.code === "operation_conflict"
      )
      assert.equal(await pageB.getByLabel("Message").inputValue(), "aaab")
      assert.equal(Number(await pageB.locator("#input-events").textContent()), before + 4)
      const chordOptions = { operationId: randomUUID() }
      const beforeChord = Number(await pageB.locator("#chords").textContent())
      await pageA.keyboard.press("Control+a", chordOptions)
      await pageA.keyboard.press("Control+a", chordOptions)
      await assert.rejects(
        pageA.keyboard.press("Control+b", chordOptions),
        (error) => error.code === "operation_conflict"
      )
      assert.equal(Number(await pageB.locator("#chords").textContent()), beforeChord + 1)
      await a.releaseWriter()
      assert.equal((await pageB._typedHelper("health")).heldInput, 0)
      await pageA.getByLabel("Message").fill("")
      return { characters: 4, inputEvents: 4, chordEvents: 1, cachedReplays: 3, conflicts: 3 }
    }
  )
  await step("distinct scoped credentials and owner/window boundaries", async () => {
    assert.notEqual(a.clientSessionId, b.clientSessionId)
    assert.notEqual(a.endpoint.devToken, endpoint.devToken)
    await assert.rejects(
      request("/api/dev/agent/shutdown", { endpoint: b.endpoint, method: "POST", body: {} }),
      (error) => error.code === "owner_required"
    )
    await assert.rejects(
      request("/api/dev/agent/helper", {
        endpoint: b.endpoint,
        method: "POST",
        body: { window: "outside-scope", method: "title" },
      }),
      (error) => error.code === "window_scope_denied"
    )
    await assert.rejects(
      request("/api/dev/agent/evaluate", {
        endpoint: b.endpoint,
        method: "POST",
        body: { expression: "document.title" },
      }),
      (error) => error.code === "unsafe_evaluate_disabled"
    )
    await assert.rejects(
      request("/api/dev/agent/logs", { endpoint: b.endpoint }),
      (error) => error.code === "owner_required"
    )
    await assert.rejects(
      request("/api/dev/agent/sessions", {
        endpoint: b.endpoint,
        method: "POST",
        body: { windows: ["main"] },
      }),
      (error) => error.code === "owner_required"
    )
    await assert.rejects(
      request("/api/dev/health", { endpoint: b.endpoint }),
      (error) => error.code === "bad_dev_token"
    )
    await assert.rejects(
      request("/api/dev/agent/health", { endpoint: { ...b.endpoint, devToken: "f".repeat(64) } }),
      (error) => error.code === "bad_dev_token"
    )
    const mutation = { window: "main", method: "keyboard", args: ["down", { key: "Shift" }] }
    await assert.rejects(
      request("/api/dev/agent/helper", { endpoint, method: "POST", body: mutation }),
      (error) => error.code === "client_session_required"
    )
    await assert.rejects(
      request("/api/dev/agent/helper", { endpoint: b.endpoint, method: "POST", body: mutation }),
      (error) => error.code === "writer_required"
    )
    await assert.rejects(
      request("/api/dev/agent/helper", {
        endpoint: b.endpoint,
        method: "POST",
        body: mutation,
        headers: {
          "X-Cognia-Writer-Token": "bad",
          "X-Cognia-Writer-Fence": "invalid",
          "X-Cognia-Operation-Id": "bad",
        },
      }),
      (error) => error.code === "invalid_writer_fence"
    )
  })
  await step("independent snapshot refs survive another reader", async () => {
    const [first, second] = await Promise.all([pageA.snapshot(), pageB.snapshot()])
    await pageB.snapshot()
    assert.equal(await pageA.inspect(textbox(first), "inputValue"), "")
    await assert.rejects(
      pageB.inspect(textbox(first), "inputValue"),
      (error) => error.code === "stale_ref"
    )
    assert.equal(first.actionable, true)
    await pageA.act(textbox(first), "fill", { value: "alpha" })
    await assert.rejects(pageB.act(textbox(second), "fill", { value: "wrong" }), (error) =>
      ["stale_ref", "stale_snapshot"].includes(error.code)
    )
    assert.equal(await pageB.getByLabel("Message").inputValue(), "alpha")
  })
  await step("app writer excludes other agents but permits observations", async () => {
    await a.acquireWriter()
    await assert.rejects(
      pageB.getByLabel("Message").fill("wrong"),
      (error) => error.code === "writer_busy"
    )
    await assert.rejects(
      observer.page().getByLabel("Message").fill("wrong"),
      (error) => error.code === "write_scope_denied"
    )
    assert.equal(await pageB.getByLabel("Message").inputValue(), "alpha")
    await a.releaseWriter()
  })
  await step("independent Node clients use scoped IPC descriptors concurrently", async () => {
    await a.acquireWriter()
    try {
      const [read, denied] = await Promise.all([
        runClientProcess(observer, "observe"),
        runClientProcess(b, "write"),
      ])
      assert.notEqual(read.pid, denied.pid)
      assert.notEqual(read.pid, process.pid)
      assert.equal(read.value, "alpha")
      assert.equal(denied.code, "writer_busy")
      return { readerPid: read.pid, deniedWriterPid: denied.pid }
    } finally {
      await a.releaseWriter()
    }
  })
  await step("same-lease exclusion and snapshots captured during execution", async () => {
    await a.acquireWriter()
    await pageA.getByRole("button", { name: "Slow frames", exact: true }).click({ force: true })
    const body = {
      window: "main",
      query: { steps: [{ kind: "role", role: "button", name: "Count", exact: true }] },
      operation: "action",
      name: "click",
      requestId: randomUUID(),
      args: {},
      requirements: { visible: true, enabled: true, stable: true },
      options: { timeout: 3000 },
    }
    const pending = pageA._post("/api/dev/agent/locator", body)
    for (let index = 0; index < 30; index++) {
      if ((await b.status()).control.writerActive) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal((await b.status()).control.writerActive, true)
    await assert.rejects(pageA.snapshot(), (error) => error.code === "concurrent_operation")
    await assert.rejects(
      pageA._post("/api/dev/agent/locator", { ...body, requestId: randomUUID() }),
      (error) => error.code === "concurrent_operation"
    )
    const snapshot = await pageB.snapshot()
    assert.equal(snapshot.actionable, false)
    await pending
    await assert.rejects(
      pageB.act(textbox(snapshot), "fill", { value: "wrong" }),
      (error) => error.code === "writer_busy"
    )
    await pageA.getByRole("button", { name: "Fast frames", exact: true }).click({ force: true })
    await a.releaseWriter()
    await assert.rejects(
      pageB.act(textbox(snapshot), "fill", { value: "wrong" }),
      (error) => error.code === "stale_snapshot"
    )
  })
  await step("completed operation replay is cached and conflicting reuse is refused", async () => {
    await a.acquireWriter()
    const before = Number(await pageA.locator("#result").textContent())
    const body = {
      window: "main",
      query: { steps: [{ kind: "css", selector: "#count" }] },
      operation: "action",
      name: "click",
      requestId: randomUUID(),
      options: { timeout: 3000 },
      requirements: { visible: true },
    }
    const options = { operationId: randomUUID() }
    await pageA._post("/api/dev/agent/locator", body, options)
    await pageA._post("/api/dev/agent/locator", body, options)
    assert.equal(Number(await pageA.locator("#result").textContent()), before + 1)
    await assert.rejects(
      pageA._post("/api/dev/agent/locator", { ...body, name: "focus" }, options),
      (error) => error.code === "operation_conflict"
    )
    await assert.rejects(
      pageA._post("/api/dev/agent/locator", { ...body, strict: false }, options),
      (error) => error.code === "operation_conflict"
    )
    await assert.rejects(
      pageA._post("/api/dev/agent/locator", {
        ...body,
        name: "dragTo",
        args: { targetQuery: { kind: "ref", ref: "old" } },
      }),
      (error) => error.code === "ref_query_disabled"
    )
    await a.releaseWriter()
  })
  await step("ref action replay returns the retained terminal snapshot exactly once", async () => {
    await a.acquireWriter()
    const snapshot = await pageA.snapshot()
    const ref = snapshot.nodes.find((node) => node.role === "button" && node.name === "Count").ref
    const before = Number(await pageA.locator("#result").textContent())
    const options = { operationId: randomUUID() }
    const first = await pageA.act(ref, "click", {}, options)
    const cached = await pageA.act(ref, "click", {}, options)
    assert.deepEqual(cached, first)
    assert.equal(first.snapshot.actionable, true)
    assert.equal(Number(await pageA.locator("#result").textContent()), before + 1)
    await assert.rejects(pageA.act(ref, "click"), (error) => error.code === "stale_ref")
    await a.releaseWriter()
  })
  await step("held keyboard and mouse input is released before writer handoff", async () => {
    await a.acquireWriter()
    await pageA.keyboard.down("Shift")
    await pageA.mouse.move(80, 80)
    await pageA.mouse.down()
    assert.ok((await pageA._typedHelper("health")).heldInput >= 2)
    await a.releaseWriter()
    await b.acquireWriter()
    assert.equal((await pageB._typedHelper("health")).heldInput, 0)
    const handedOff = await pageB.snapshot()
    await pageB.act(textbox(handedOff), "fill", { value: "beta" })
    assert.equal(await pageA.getByLabel("Message").inputValue(), "beta")
    await b.releaseWriter()
  })
  await step("raw scoped detach shares the confirmed input cleanup path", async () => {
    const detaching = await connectTauriSession({ endpoint, canWrite: true })
    clients.push(detaching)
    await detaching.acquireWriter()
    await detaching.page().keyboard.down("Shift")
    await detaching.page().mouse.down()
    await request("/api/dev/agent/session", { endpoint: detaching.endpoint, method: "DELETE" })
    detaching.closed = true
    detaching.lease = null
    await b.acquireWriter()
    assert.equal((await pageB._typedHelper("health")).heldInput, 0)
    await b.releaseWriter()
    await assert.rejects(detaching.status(), (error) => error.code === "session_closed")
    await assert.rejects(
      request("/api/dev/agent/session", { endpoint: detaching.endpoint }),
      (error) => error.code === "bad_dev_token"
    )
  })
  await step("typed SPA URL waits and history remain usable", async () => {
    await pageA.getByRole("button", { name: "SPA navigation" }).click({ waitForURL: /done=1$/ })
    assert.match(await pageA.url(), /done=1$/)
    await pageA.goBack()
    assert.equal(await pageA.url(), fixtureUrl)
    await pageA.goForward()
    assert.match(await pageA.url(), /done=1$/)
  })
  await step("scoped page close detaches without shutting down the app", async () => {
    await observer.page().close()
    assert.equal((await b.status()).control.sessions, 2)
    assert.equal(
      (await request("/api/dev/agent/health?nativeOnly=true", { endpoint })).agentDebug,
      true
    )
  })
  await step(
    "owner management rejects scoped credentials and revokes only the chosen client",
    async () => {
      for (const [route, method] of [
        ["/sessions", "GET"],
        ["/sessions/not-owned", "DELETE"],
        ["/recover", "POST"],
      ]) {
        await assert.rejects(
          request(`/api/dev/agent${route}`, { endpoint: b.endpoint, method }),
          (error) => error.code === "owner_required"
        )
      }
      const victim = await connectTauriSession({ endpoint, canWrite: true })
      await victim.acquireWriter()
      const list = await request("/api/dev/agent/sessions", { endpoint })
      assert(!JSON.stringify(list).includes(victim.endpoint.devToken))
      const revoked = await request(`/api/dev/agent/sessions/${victim.clientSessionId}`, {
        endpoint,
        method: "DELETE",
      })
      assert.equal(revoked.result.recoveryRequired, false)
      await assert.rejects(victim.status(), (error) => error.code === "bad_dev_token")
      await b.acquireWriter()
      await b.releaseWriter()
      return { revoked: revoked.result, listed: list.sessions.length }
    }
  )
  await step("scoped CLI persists its lease and detaches without owner fallback", async () => {
    const file = path.join(outputDir, "cli-client.json")
    const attached = await cli(["attach", "--output", file, "--can-write"])
    assert(!JSON.stringify(attached).includes("token"))
    const proof = JSON.parse(await fs.readFile(file, "utf8"))
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
    const denied = await cli(["stop", "--client", file], false)
    assert.equal(denied.code, "owner_command_denied")
    const acquired = await cli(["lease", "acquire", "--client", file])
    assert(acquired.fence > 0)
    await cli(["lease", "renew", "--client", file])
    const snap = await cli(["snapshot", "--client", file])
    const ref = snap.nodes.find((node) => node.role === "textbox").ref
    await cli(["act", ref, "fill", "--value", "from-cli", "--client", file])
    assert.equal(await pageB.getByLabel("Message").inputValue(), "from-cli")
    // Simulate a client dying after grant but before proof publication.
    await fs.writeFile(file, JSON.stringify({ ...proof, lease: null }), { mode: 0o600 })
    await cli(["lease", "release", "--client", file])
    await b.acquireWriter()
    await b.releaseWriter()
    await cli(["detach", "--client", file])
    await assert.rejects(fs.stat(file), { code: "ENOENT" })
    return { clientSessionId: attached.clientSessionId, writerFence: acquired.fence }
  })
  await step("more than sixteen short-lived clients reclaim native and renderer refs", async () => {
    for (let i = 0; i < 18; i++) {
      const expiring = await connectTauriSession({ endpoint, idleTimeoutMs: 1000 })
      await expiring.page().snapshot()
      await new Promise((resolve) => setTimeout(resolve, 1050))
      await assert.rejects(expiring.status(), (error) => error.code === "bad_dev_token")
    }
    const fresh = await connectTauriSession({ endpoint })
    assert((await fresh.page().snapshot()).nodes.length > 0)
    await fresh.detach()
    return { expiredClients: 18, idleTimeoutMs: 1000 }
  })
  await step(
    "bounded concurrent readers and competing writers preserve exact effects",
    async () => {
      const pool = await Promise.all(
        Array.from({ length: 8 }, () => connectTauriSession({ endpoint, canWrite: true }))
      )
      const before = Number(await pageB.locator("#result").textContent())
      const reads = await Promise.all(
        pool.map(async (client) => {
          for (let i = 0; i < 10; i++) assert((await client.page().snapshot()).nodes.length > 0)
          return 10
        })
      )
      const writes = await Promise.allSettled(
        pool.map((client) =>
          client.page().getByRole("button", { name: "Count", exact: true }).click()
        )
      )
      const successes = writes.filter((result) => result.status === "fulfilled").length
      for (const result of writes)
        if (result.status === "rejected") assert.equal(result.reason.code, "writer_busy")
      assert(successes >= 1)
      assert.equal(Number(await pageB.locator("#result").textContent()), before + successes)
      await Promise.all(pool.map((client) => client.detach()))
      return {
        clients: 8,
        reads: reads.reduce((sum, n) => sum + n, 0),
        writes: successes,
        rejected: writes.length - successes,
      }
    }
  )
  await step("killed independent writer expires naturally before handoff", async () => {
    const victim = await connectTauriSession({ endpoint, canWrite: true })
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const {TauriClientSession}=await import(process.argv[1]);
      process.once('message',async descriptor=>{const client=new TauriClientSession(descriptor);await client.acquireWriter();process.send({held:true,pid:process.pid});await new Promise(()=>{})});
    `,
        new URL("./agent-debug-client.mjs", import.meta.url).href,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] }
    )
    const held = once(child, "message")
    child.send(victim.toJSON())
    const [message] = await held
    await assert.rejects(b.acquireWriter(), (error) => error.code === "writer_busy")
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    const started = performance.now()
    await new Promise((resolve) => setTimeout(resolve, 16_000))
    await b.acquireWriter()
    await b.releaseWriter()
    await victim.detach()
    return { clientPid: message.pid, waitedMs: Math.round(performance.now() - started) }
  })
  await pageA.screenshot({ path: path.join(outputDir, "fixture.png") })
  await fs.writeFile(
    path.join(outputDir, "console.json"),
    JSON.stringify(await pageB.readConsole(), null, 2)
  )
  await fs.writeFile(
    path.join(outputDir, "network.json"),
    JSON.stringify(await pageB.readNetwork(), null, 2)
  )
  await step("timed-out execution cannot hand an uncertain writer to another agent", async () => {
    await a.acquireWriter()
    await pageA.getByRole("button", { name: "Slow frames", exact: true }).click({ force: true })
    const before = await pageB.locator("#result").textContent()
    const body = {
      window: "main",
      query: { steps: [{ kind: "css", selector: "#count" }] },
      operation: "action",
      name: "click",
      requestId: randomUUID(),
      options: { timeout: 80 },
      requirements: { stable: true, visible: true },
    }
    let terminal
    try {
      terminal = await pageA._post("/api/dev/agent/locator", body, { timeout: 3000 })
    } catch (error) {
      terminal = { error: error.code || error.message }
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(await pageB.locator("#result").textContent(), before, "no late click after expiry")
    const control = (await b.status()).control
    if (control.quarantined)
      await assert.rejects(b.acquireWriter(), (error) => error.code === "target_quarantined")
    else {
      assert.equal(control.writerActive, false)
      assert.equal(terminal.locator?.dispatchState, "not-dispatched")
      await a.releaseWriter()
      await b.acquireWriter()
      await b.releaseWriter()
    }
    return { terminal, control }
  })
  await step(
    "failed recovery stays closed and retry restores every document at the same native PID",
    async () => {
      const beforePid = (await request("/api/dev/agent/health?nativeOnly=true", { endpoint })).pid
      const previousDocument = (await request("/api/dev/agent/health", { endpoint })).helper
        .documentId
      holdReloads = true
      await assert.rejects(
        request("/api/dev/agent/recover", { endpoint, method: "POST", body: {}, timeout: 35_000 }),
        (error) => error.code === "outcome_unknown"
      )
      const closed = await request("/api/dev/agent/sessions", { endpoint })
      assert.equal(closed.control.quarantined, true)
      await assert.rejects(
        connectTauriSession({ endpoint }),
        (error) => error.code === "recovery_in_progress"
      )
      holdReloads = false
      for (const response of pendingReadResponses) response.end("cleanup")
      pendingReadResponses.clear()
      for (const response of pendingResponses) sendFixture(response)
      pendingResponses.clear()
      // Drain the first reload before requesting another document replacement.
      const loadDeadline = performance.now() + 15000
      let loaded = false
      while (performance.now() < loadDeadline) {
        const current = await request("/api/dev/agent/health", { endpoint })
        if (
          current.helper?.documentId !== previousDocument &&
          current.helper?.readyState === "complete" &&
          !current.renderers.main.documentLoading
        ) {
          loaded = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert(loaded, "the first recovery reload must finish before its explicit retry")
      const recovered = await request("/api/dev/agent/recover", {
        endpoint,
        method: "POST",
        body: {},
        timeout: 35_000,
      })
      assert.equal(recovered.pid, beforePid)
      assert.equal(recovered.control.quarantined, false)
      assert.equal(recovered.control.writerActive, false)
      await assert.rejects(b.status(), (error) => error.code === "bad_dev_token")
      for (const old of clients) {
        old.closed = true
        old.lease = null
      }
      const fresh = await connectTauriSession({ endpoint, canWrite: true })
      clients.push(fresh)
      await fresh.page().getByLabel("Message").fill("recovered")
      await fresh.page().getByRole("button", { name: "Count", exact: true }).click()
      assert.equal(await fresh.page().locator("#result").textContent(), "1")
      await fresh.page().screenshot({ path: path.join(outputDir, "recovered.png") })
      return {
        beforePid,
        afterPid: recovered.pid,
        failedRecoveryClosed: true,
        documents: recovered.documents,
      }
    }
  )
  await step(
    "outer abort cancels in-flight delayed input through the existing locator registry",
    async () => {
      const writer = await connectTauriSession({ endpoint, canWrite: true })
      const reader = await connectTauriSession({ endpoint, canWrite: true })
      clients.push(writer, reader)
      await writer.page().getByLabel("Message").fill("")
      await writer.page().getByLabel("Message").focus()
      const controller = new AbortController()
      const work = writer.withWriter(() => writer.page().keyboard.type("ab", { delay: 2000 }), {
        signal: controller.signal,
      })
      const rejected = assert.rejects(work, /cancel delayed input/)
      await tauriExpect(reader.page().getByLabel("Message")).toHaveValue("a", { timeout: 3000 })
      controller.abort(new Error("cancel delayed input"))
      await rejected
      await new Promise((resolve) => setTimeout(resolve, 2200))
      assert.equal(await reader.page().getByLabel("Message").inputValue(), "a")
      const control = (await request("/api/dev/agent/sessions", { endpoint })).control
      if (control.quarantined) {
        await assert.rejects(reader.acquireWriter(), (error) => error.code === "target_quarantined")
        await request("/api/dev/agent/recover", {
          endpoint,
          method: "POST",
          body: {},
          timeout: 35000,
        })
        for (const old of clients) {
          old.closed = true
          old.lease = null
        }
      } else {
        assert.equal(control.writerActive, false)
        await writer.releaseWriter()
      }
      return { typed: "a", lateCharacters: 0, quarantined: control.quarantined }
    }
  )
  await step(
    "an already-dispatched inspector cannot publish after revoke or recovery",
    async () => {
      const results = []
      const beforePid = (await request("/api/dev/agent/health?nativeOnly=true", { endpoint })).pid
      for (const mode of ["revoke", "recover"]) {
        const reader = await connectTauriSession({ endpoint })
        clients.push(reader)
        const before = readArrivals
        const read = reader
          .page()
          .getByLabel("Message")
          .getAttribute("data-boundary")
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, code: error.code })
          )
        const deadline = performance.now() + 5000
        while (readArrivals === before && performance.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10))
        assert(readArrivals > before, "the renderer must begin the actual getter before retirement")
        let recovery
        if (mode === "revoke")
          await request(`/api/dev/agent/sessions/${reader.clientSessionId}`, {
            endpoint,
            method: "DELETE",
          })
        else {
          recovery = request("/api/dev/agent/recover", {
            endpoint,
            method: "POST",
            body: {},
            timeout: 35000,
          })
          const frozenDeadline = performance.now() + 5000
          while (
            !(await request("/api/dev/agent/sessions", { endpoint })).control.recovering &&
            performance.now() < frozenDeadline
          )
            await new Promise((resolve) => setTimeout(resolve, 10))
          assert((await request("/api/dev/agent/sessions", { endpoint })).control.recovering)
        }
        for (const response of pendingReadResponses) response.end("must-not-publish")
        pendingReadResponses.clear()
        const result = await read
        assert.equal(result.ok, false)
        assert.equal(result.code, "session_closed")
        results.push({ mode, ...result, readStarted: true })
        if (recovery) {
          const recovered = await recovery
          assert.equal(recovered.pid, beforePid)
          for (const old of clients) {
            old.closed = true
            old.lease = null
          }
        } else {
          reader.closed = true
        }
      }
      const fresh = await connectTauriSession({ endpoint, canWrite: true })
      clients.push(fresh)
      await fresh.page().getByLabel("Message").fill("publication-boundary-recovered")
      return { pid: beforePid, results }
    }
  )
  await step("in-flight observer reads cannot publish across recovery", async () => {
    const loader = await connectTauriSession({ endpoint, canWrite: true })
    const readers = await Promise.all(
      Array.from({ length: 3 }, () => connectTauriSession({ endpoint }))
    )
    clients.push(loader, ...readers)
    await Promise.all(readers.map((reader) => reader.verifyIdentity()))
    const beforePid = (await request("/api/dev/agent/health?nativeOnly=true", { endpoint })).pid
    holdReloads = true
    streamLoading = true
    const navigation = loader
      .page()
      .goto(fixtureUrl + "?observer-boundary")
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, code: error.code })
      )
    const wait = async (check, message) => {
      const deadline = performance.now() + 5000
      while (performance.now() < deadline) {
        if (await check()) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(message)
    }
    await wait(async () => {
      const status = await request("/api/dev/agent/health?nativeOnly=true", { endpoint })
      return status.renderers.main.documentLoading
    }, "navigation did not enter the controlled loading barrier")
    await new Promise((resolve) => setTimeout(resolve, 100))
    const before = (await request("/api/dev/agent/sessions", { endpoint })).sessions
    const idle = new Map(before.map((session) => [session.clientSessionId, session.idleForMs]))
    const reads = [
      readers[0].page().readConsole(),
      readers[1].page().readNetwork(),
      readers[2].page().content(),
    ].map((read) =>
      read.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, code: error.code })
      )
    )
    await wait(async () => {
      const current = (await request("/api/dev/agent/sessions", { endpoint })).sessions
      return readers.every(
        (reader) =>
          current.find((session) => session.clientSessionId === reader.clientSessionId)?.idleForMs <
          idle.get(reader.clientSessionId)
      )
    }, "observer requests did not authenticate before recovery")
    const recovering = request("/api/dev/agent/recover", {
      endpoint,
      method: "POST",
      body: {},
      timeout: 35000,
    })
    await wait(
      async () => (await request("/api/dev/agent/sessions", { endpoint })).control.recovering,
      "owner recovery did not freeze admission"
    )
    holdReloads = false
    streamLoading = false
    for (const response of pendingResponses) sendFixture(response)
    pendingResponses.clear()
    const recovered = await recovering
    const results = await Promise.all(reads)
    for (const result of results) {
      assert.equal(result.ok, false)
      assert.equal(result.code, "session_closed")
    }
    await navigation
    assert.equal(recovered.pid, beforePid)
    for (const old of clients) {
      old.closed = true
      old.lease = null
    }
    const fresh = await connectTauriSession({ endpoint, canWrite: true })
    clients.push(fresh)
    await fresh.page().getByLabel("Message").fill("observer-boundary-recovered")
    assert.equal(
      await fresh.page().getByLabel("Message").inputValue(),
      "observer-boundary-recovered"
    )
    for (const reader of readers)
      await assert.rejects(
        request("/api/dev/agent/screenshot", { endpoint: reader.endpoint }),
        (error) => error.code === "bad_dev_token"
      )
    await fresh.page().screenshot({ path: path.join(outputDir, "observer-recovered.png") })
    return { beforePid, afterPid: recovered.pid, oldReads: results, retiredScreenshotsDenied: 3 }
  })
} catch (error) {
  failed = { message: error.message, code: error.code, stack: error.stack }
  console.error(error)
} finally {
  if (failed) {
    try {
      holdReloads = false
      for (const response of pendingReadResponses) response.end("cleanup")
      pendingReadResponses.clear()
      for (const response of pendingResponses) sendFixture(response)
      pendingResponses.clear()
      await request("/api/dev/agent/recover", {
        endpoint,
        method: "POST",
        body: {},
        timeout: 35_000,
      })
      for (const old of clients) {
        old.closed = true
        old.lease = null
      }
      const restore = await connectTauriSession({ endpoint, canWrite: true })
      await restore.page().goto(health.helper.url)
      await restore.detach()
    } catch (error) {
      failed.cleanupRecovery = error.code || error.message
    }
  }
  const cleanup = []
  for (const client of clients.reverse()) {
    if (client.closed) continue
    try {
      await client.detach()
      cleanup.push({ clientSessionId: client.clientSessionId, detached: true })
    } catch (error) {
      cleanup.push({ clientSessionId: client.clientSessionId, detached: false, code: error.code })
    }
  }
  const evidence = {
    ok: !failed,
    platform: process.platform,
    runtime: { node: process.version, pid: process.pid, parentPid: process.ppid },
    fixtureUrl,
    app: health.debugSession,
    sourceHashes,
    steps,
    failed,
    cleanup,
  }
  await fs.writeFile(path.join(outputDir, "acceptance.json"), JSON.stringify(evidence, null, 2))
  holdReloads = false
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  console.log(`Evidence: ${outputDir}`)
}
if (failed) process.exitCode = 1
