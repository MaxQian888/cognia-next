import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  converse,
  hasFinalAnswer,
  loadSupport,
  parseArgs,
  snapshotConfig,
  typeRendered,
} from "./cli-conversation-real.mjs"

let support
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-real-smoke-test-"))
before(async () => {
  support = await loadSupport(directory)
})
after(() => fs.rmSync(directory, { recursive: true, force: true }))

test("explicit Pi and model/policy flags accept pnpm's separator without doctor", () => {
  const args = parseArgs([
    "--",
    "--backend",
    "pi-rpc",
    "--model",
    "provider/model",
    "--pi-extension-policy",
    "global",
  ])
  assert.equal(args.backend, "pi-rpc")
  assert.equal(args.model, "provider/model")
  assert.equal(args.piExtensionPolicy, "global")
  assert.ok(support.BUILTIN_EXECUTABLE_PRESET_IDS.includes(args.backend))
})

test("reject missing arguments, unsafe input and prompt-echo assertions", () => {
  for (const argv of [
    [],
    ["--backend"],
    ["--backend", "--model", "x"],
    ["--backend", "pi-rpc", "--timeout", "NaN"],
    ["--backend", "pi-rpc", "--prompt", "say hi"],
    ["--backend", "pi-rpc", "--prompt", "say READY", "--expect", "READY"],
    ["--backend", "pi-rpc", "--prompt", "hello\nworld", "--expect", "answer"],
    ["--backend", "pi-rpc", "--prompt", "!touch file", "--expect", "answer"],
    ["--backend", "builtin", "--pi-extension-policy", "global"],
  ]) {
    assert.throws(() => parseArgs(argv))
  }
})

test("reuse layered model, Pi policy and credentials without mutating original settings", () => {
  const files = {
    "/original/config.json": JSON.stringify({
      agentBackends: {
        "pi-rpc": {
          model: "user/model",
          piExtensionPolicy: "global",
        },
      },
      permissionMode: "default",
    }),
    "/original/credentials.json": JSON.stringify({
      providers: { anthropic: { apiKey: "test-private-key" } },
    }),
    "/project/.cognia/config.json": JSON.stringify({
      agentBackends: { "pi-rpc": { model: "project/model" } },
    }),
  }
  const resolved = support.resolveConfig({
    home: "/original",
    cwd: "/project",
    env: {},
    readFile: (p) => files[p] ?? null,
  })
  const before = structuredClone(resolved)
  const snapshot = snapshotConfig(
    resolved,
    support.cliConfigFileSchema,
    parseArgs(["--backend", "pi-rpc"]),
    "/temporary"
  )
  assert.equal(snapshot.cwd, "/temporary")
  assert.equal(snapshot.permissionMode, "default")
  assert.deepEqual(snapshot.agentBackends["pi-rpc"], {
    model: "project/model",
    piExtensionPolicy: "global",
  })
  assert.equal(snapshot.providers.anthropic.apiKey, "test-private-key")
  assert.ok(!("cliHome" in snapshot))
  assert.deepEqual(resolved, before)
  const override = snapshotConfig(
    resolved,
    support.cliConfigFileSchema,
    parseArgs([
      "--backend",
      "pi-rpc",
      "--model",
      "selected/model",
      "--pi-extension-policy",
      "isolated",
    ]),
    "/temporary"
  )
  assert.deepEqual(override.agentBackends["pi-rpc"], {
    model: "selected/model",
    piExtensionPolicy: "isolated",
  })
})

test("builtin model override updates its provider slot instead of external backend memory", () => {
  const config = support.resolveConfig({
    home: "/empty",
    cwd: "/project",
    env: {},
    readFile: () => null,
  })
  const snapshot = snapshotConfig(
    config,
    support.cliConfigFileSchema,
    parseArgs(["--backend", "builtin", "--model", "new-model"]),
    "/temp"
  )
  assert.equal(snapshot.providers.anthropic.model, "new-model")
})

test("rendered answer check rejects echo, token counts and erased/unfinished output", () => {
  const screen = new support.TerminalScreen({ columns: 100, rows: 10 })
  screen.write("› Reply with READY\r\n123 tok\r\nAsk, run /commands")
  assert.equal(hasFinalAnswer(screen, "READY"), false)
  screen.write("\x1b[2J\x1b[HREADY\r\nWorking")
  assert.equal(hasFinalAnswer(screen, "READY"), false)
  screen.write("\x1b[2J\x1b[HREADY\r\nAsk, run /commands")
  assert.equal(hasFinalAnswer(screen, "READY"), true)
  screen.write("\x1b[2J\x1b[HAsk, run /commands")
  assert.equal(hasFinalAnswer(screen, "READY"), false)
})

test("each character waits for fresh composer rendering, not a matching banner", async () => {
  const screen = new support.TerminalScreen({ columns: 100, rows: 10 })
  let revision = 0
  let typed = ""
  const writes = []
  await typeRendered(
    {
      write(char) {
        writes.push(char)
      },
    },
    screen,
    async (check) => {
      assert.equal(check(), false)
      screen.write(`\x1b[2J\x1b[Hbanner A B\r\n› ${typed}`)
      revision++
      if (writes.at(-1) !== " ") assert.equal(check(), false)
      typed += writes.at(-1)
      screen.write(`\x1b[2J\x1b[H› ${typed}`)
      revision++
      assert.equal(check(), true)
    },
    "A B",
    () => revision
  )
  assert.deepEqual(writes, ["A", " ", "B", "\r"])
})

test("real PTY exchange uses delayed per-character frames and restores terminal modes", async () => {
  const { default: pty } = await import("node-pty")
  const fixture = path.join(directory, "terminal.cjs")
  fs.writeFileSync(
    fixture,
    `
process.stdin.setRawMode(true); process.stdin.resume();
let text = "";
const paint = value => process.stdout.write("\\x1b[2J\\x1b[H" + value);
process.stdout.write("\\x1b[?1049h\\x1b[?25l\\x1b[?1006h");
paint("Do you trust this workspace?");
let trusted = false;
process.stdin.on("data", data => {
  if (data.length !== 1) process.exit(7);
  const char = data.toString();
  if (!trusted) { trusted = true; paint("› Ask, run /commands"); return; }
  if (char === "\\r") { paint("› " + text + "\\r\\n900 tok"); setTimeout(() => paint("› " + text + "\\r\\n4786\\r\\n› Ask, run /commands"), 40); }
  else { text += char; setTimeout(() => paint("› " + text), 30); }
});
process.on("SIGINT", () => { process.stdout.write("\\x1b[?1006l\\x1b[?25h\\x1b[?1049l"); process.exit(0); });
`
  )
  const terminal = pty.spawn(process.execPath, [fixture], {
    name: "xterm",
    cols: 100,
    rows: 20,
    cwd: directory,
    env: process.env,
  })
  await converse({
    terminal,
    screen: new support.TerminalScreen({ columns: 100, rows: 20 }),
    prompt: "Add these numbers",
    expected: "4786",
    timeoutMs: 5000,
  })
})

test("invalid CLI input never prints arbitrary argument values", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./cli-conversation-real.mjs", import.meta.url).pathname, "secret-value"],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 2)
  assert.ok(!result.stderr.includes("secret-value"))
})

test("billing without an answer times out and still shuts down the terminal", async () => {
  let data
  let exit
  let typed = ""
  let killed = false
  const terminal = {
    onData(callback) {
      data = callback
      setImmediate(() => data("› Ask, run /commands"))
    },
    onExit(callback) {
      exit = callback
    },
    write(char) {
      if (char !== "\r") typed += char
      setImmediate(() => data(`\x1b[2J\x1b[H› ${typed}\r\n100 tok`))
    },
    kill() {
      killed = true
      exit({ exitCode: 0 })
    },
  }
  await assert.rejects(
    converse({
      terminal,
      screen: new support.TerminalScreen({ columns: 100, rows: 20 }),
      prompt: "Sum?",
      expected: "4786",
      timeoutMs: 200,
    }),
    /final answer and idle composer/u
  )
  assert.equal(killed, true)
})

test("early backend exit fails promptly rather than waiting for the full budget", async () => {
  const terminal = {
    onData() {},
    onExit(callback) {
      setImmediate(() => callback({ exitCode: 1 }))
    },
    write() {
      assert.fail("must not type before composer")
    },
    kill() {
      assert.fail("must not kill a process already exited")
    },
  }
  await assert.rejects(
    converse({
      terminal,
      screen: new support.TerminalScreen({ columns: 100, rows: 20 }),
      prompt: "Sum?",
      expected: "4786",
      timeoutMs: 1000,
    }),
    /process exited/u
  )
})
