/** @jest-environment node */
import { build, stop } from "esbuild"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"
import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { createCrushSocketBridge } from "./socket-bridge"

afterAll(() => stop())

it("owns a private Unix listener, forwards bounded HTTP and reaps its native child/socket", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cr-bridge-test-")),
    bundle = path.join(directory, "bridge.cjs"),
    fixture = path.join(directory, "crush")
  let child: ChildProcess | undefined
  try {
    await build({
      entryPoints: [path.join(__dirname, "node-bridge.ts")],
      outfile: bundle,
      platform: "node",
      format: "cjs",
      target: "node26",
      bundle: true,
      logLevel: "silent",
    })
    await fs.writeFile(
      fixture,
      `#!${process.execPath}\nconst http=require('node:http'),fs=require('node:fs'),path=require('node:path'); const args=process.argv.slice(2); if(args[0]!=='server'||args[1]!=='--host'||!args[2].startsWith('unix://'))process.exit(2);const socket=args[2].slice(7);fs.writeFileSync(path.join(process.cwd(),'launch.json'),JSON.stringify({args,socket,pid:process.pid,mode:fs.statSync(path.dirname(socket)).mode&511}));const server=http.createServer((req,res)=>{let data='';req.on('data',v=>data+=v);req.on('end',()=>{res.setHeader('content-type','application/json');res.end(req.url==='/v1/health'?JSON.stringify({status:'ok'}):data)})});server.listen(socket);process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`,
      { mode: 0o700 }
    )
    const lines = new Set<Parameters<AgentProcessHost["onStdoutLine"]>[0]>(),
      exits = new Set<Parameters<AgentProcessHost["onExit"]>[0]>()
    let processId = ""
    const host: AgentProcessHost = {
      available: true,
      commandExists: async () => true,
      spawn: async (spec) => {
        processId = spec.id
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: {
            ...process.env,
            ...spec.env,
            PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          stdio: ["pipe", "pipe", "pipe"],
        })
        createInterface({ input: child.stdout! }).on("line", (data) => {
          for (const listener of lines) listener({ processId, data })
        })
        child.once("exit", (code) => {
          for (const listener of exits) listener({ processId, code: code ?? -1 })
        })
        return processId
      },
      send: async (_, raw) => {
        if (!child?.stdin?.write(raw + "\n")) await once(child!.stdin!, "drain")
      },
      kill: async () => {
        if (!child || child.exitCode !== null) return
        const exited = once(child, "exit")
        child.kill("SIGTERM")
        await exited
      },
      onStdoutLine: async (cb) => {
        lines.add(cb)
        return () => lines.delete(cb)
      },
      onStdoutRaw: async () => () => {},
      onStderr: async () => () => {},
      onExit: async (cb) => {
        exits.add(cb)
        return () => exits.delete(cb)
      },
    }
    const bridge = createCrushSocketBridge({
      processHost: host,
      outboundGate: () => true,
      resolveBridgeLaunch: async () => ({
        command: process.execPath,
        args: [bundle, "--cognia-crush-bridge"],
      }),
    })
    const service = await bridge.launch(
      { id: "cr", process: { command: "crush", cwd: directory } } as never,
      directory
    )
    const record = JSON.parse(await fs.readFile(path.join(directory, "launch.json"), "utf8")) as {
      socket: string
      pid: number
      mode: number
    }
    expect(record.mode).toBe(0o700)
    expect(record.socket).toMatch(/c-.*\/s$/)
    const response = await bridge.fetch(service.endpoint + "/v1/echo", {
      method: "POST",
      body: JSON.stringify({ prompt: "fixture" }),
      headers: service.headers,
    })
    expect(await response.json()).toEqual({ prompt: "fixture" })
    await service.close()
    expect(lines.size).toBe(0)
    expect(exits.size).toBe(0)
    await expect(fs.stat(path.dirname(record.socket))).rejects.toMatchObject({ code: "ENOENT" })
    expect(() => process.kill(record.pid, 0)).toThrow()
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL")
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
