import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { build } from "esbuild"
import { isMcpOauthHelperEntry } from "../../mcp-oauth-helper.mjs"

test("collapsed sidecar URLs are not OAuth helper entrypoints, with or without a role", () => {
  for (const role of [undefined, "sidecar"]) {
    for (const argvPath of ["/dist/sidecar/claude-host.mjs", "/$bunfs/root/cognia-agent"]) {
      assert.equal(
        isMcpOauthHelperEntry({ role, importUrl: pathToFileURL(argvPath).href, argvPath }),
        false
      )
    }
  }
})

test("standalone helper retains entry support even with an inherited sidecar role", () => {
  const argvPath = path.resolve("directory with spaces/mcp-oauth-helper.mjs")
  for (const role of [undefined, "sidecar"]) {
    assert.equal(
      isMcpOauthHelperEntry({ role, importUrl: pathToFileURL(argvPath).href, argvPath }),
      true
    )
  }
  assert.equal(
    isMcpOauthHelperEntry({ argvPath: undefined, importUrl: "file:///helper.mjs" }),
    false
  )
  assert.equal(
    isMcpOauthHelperEntry({ argvPath, importUrl: "file:///another/mcp-oauth-helper.mjs" }),
    false
  )
})

test("real standalone helper consumes its own request with inherited role", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "../../mcp-oauth-helper.mjs"), "refresh"],
    {
      input: JSON.stringify({ server: { transport: "stdio" }, entry: {} }) + "\n",
      env: { ...process.env, COGNIA_ROLE: "sidecar" },
      encoding: "utf8",
      timeout: 5000,
    }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).result.status, "unsupported")
})

test("bundled library import cannot consume host IPC or exit after its first command", async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-oauth-entry-")))
  const outfile = path.join(directory, "claude-host.mjs")
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    await build({
      stdin: {
        contents: `
import {parseCallback} from ${JSON.stringify(path.join(import.meta.dirname, "../../mcp-oauth-helper.mjs"))};
import readline from "node:readline";
const rl = readline.createInterface({input: process.stdin});
rl.on("line", line => {
  const command = JSON.parse(line);
  setImmediate(() => process.stdout.write(JSON.stringify({type: "control_response", requestId: command.requestId, callbackCode: parseCallback("/cb?code=ok").code}) + "\\n"));
});
process.stdout.write('{"type":"ready"}\\n');
`,
        resolveDir: import.meta.dirname,
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      banner: {
        js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);',
      },
      logLevel: "silent",
    })
    const env = { PATH: process.env.PATH, HOME: directory }
    child = spawn(process.execPath, [outfile], {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (data) => {
      stderr += data
    })
    child.stdin.on("error", () => {})
    const frames: Record<string, unknown>[] = []
    let buffer = ""
    let notify = () => {}
    child.stdout.on("data", (data) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      frames.push(...lines.filter(Boolean).map((line) => JSON.parse(line)))
      notify()
    })
    const waitFor = (predicate: (frame: Record<string, unknown>) => boolean) =>
      new Promise<void>((resolve, reject) => {
        const fail = () => {
          cleanup()
          reject(new Error(`bundled host exited: ${stderr}`))
        }
        const timer = setTimeout(fail, 5000)
        const cleanup = () => {
          clearTimeout(timer)
          child!.off("exit", fail)
          notify = () => {}
        }
        child!.once("exit", fail)
        notify = () => {
          if (frames.some(predicate)) {
            cleanup()
            resolve()
          }
        }
        if (child!.exitCode !== null) fail()
        else notify()
      })
    await waitFor((frame) => frame.type === "ready")
    for (const requestId of ["first", "second"]) {
      child.stdin.write(
        JSON.stringify({ type: "control", method: "mcpServerStatus", requestId }) + "\n"
      )
      await waitFor((frame) => frame.type === "control_response" && frame.requestId === requestId)
    }
    assert.ok(frames.every((frame) => frame.type === "ready" || frame.type === "control_response"))
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL")
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
