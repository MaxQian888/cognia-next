/** Node-only private Unix-socket transport. Never imported by the app entry. */
import * as http from "node:http"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import {
  CRUSH_SOCKET_FRAME_LIMIT,
  decodeCrushSocketFrame,
  encodeCrushSocketFrame,
  type CrushSocketFrame,
} from "./socket-bridge"

export async function startCrushNodeBridge(): Promise<void> {
  if (process.platform === "win32")
    throw new Error("Crush private Unix socket bridge is not available on Windows")
  let output = Promise.resolve(),
    directory: string | undefined,
    socketPath: string | undefined,
    child: ChildProcess | undefined,
    closing = false
  const requests = new Map<string, http.ClientRequest>(),
    acks = new Map<string, () => void>()
  const send = (frame: CrushSocketFrame): Promise<void> => {
    const line = encodeCrushSocketFrame(frame) + "\n"
    output = output.then(async () => {
      if (!process.stdout.write(line)) await once(process.stdout, "drain")
    })
    return output
  }
  const close = async () => {
    if (closing) return
    closing = true
    for (const request of requests.values()) request.destroy()
    requests.clear()
    for (const ack of acks.values()) ack()
    acks.clear()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => {})
      child.kill("SIGTERM")
      const timer = setTimeout(() => child?.kill("SIGKILL"), 2000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true })
  }
  const request = async (frame: CrushSocketFrame) => {
    if (
      !socketPath ||
      closing ||
      typeof frame.requestId !== "string" ||
      typeof frame.path !== "string" ||
      !frame.path.startsWith("/v1/") ||
      frame.path.startsWith("//") ||
      !["GET", "POST", "DELETE", "PATCH", "PUT"].includes(String(frame.method))
    )
      throw new Error("Invalid Crush socket HTTP operation")
    const id = frame.requestId
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            path: String(frame.path),
            method: String(frame.method),
            headers: { "Content-Type": "application/json" },
          },
          resolve
        )
        requests.set(id, req)
        req.once("error", reject)
        if (typeof frame.body === "string") req.write(frame.body)
        req.end()
      })
      const headers = Object.fromEntries(
        Object.entries(response.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
      )
      await send({ type: "head", requestId: id, status: response.statusCode, headers })
      let seq = 0
      for await (const raw of response) {
        const chunk = Buffer.from(raw)
        for (let start = 0; start < chunk.length; start += 64 * 1024) {
          if (closing || !requests.has(id)) throw new Error("Crush request cancelled")
          const key = `${id}:${seq}`,
            acknowledged = new Promise<void>((resolve) => acks.set(key, resolve))
          const timer = setTimeout(() => {
            requests.get(id)?.destroy()
            acks.get(key)?.()
          }, 30_000)
          try {
            await send({
              type: "chunk",
              requestId: id,
              seq,
              data: chunk.subarray(start, start + 64 * 1024).toString("base64"),
            })
            await acknowledged
          } finally {
            clearTimeout(timer)
            acks.delete(key)
          }
          seq++
        }
      }
      await send({ type: "end", requestId: id })
    } catch {
      await send({ type: "error", requestId: id }).catch(() => {})
    } finally {
      requests.delete(id)
    }
  }
  const receive = async (raw: string) => {
    const frame = decodeCrushSocketFrame(raw)
    if (frame.type === "ack") {
      acks.get(`${frame.requestId}:${frame.seq}`)?.()
      return
    }
    if (frame.type === "cancel") {
      requests.get(String(frame.requestId))?.destroy()
      requests.delete(String(frame.requestId))
      for (const [key, ack] of acks) if (key.startsWith(`${frame.requestId}:`)) ack()
      return
    }
    if (frame.type === "close") {
      await close()
      return
    }
    if (frame.type === "request") {
      void request(frame).catch(() => close())
      return
    }
    if (
      frame.type !== "init" ||
      child ||
      frame.command !== "crush" ||
      typeof frame.cwd !== "string" ||
      !path.isAbsolute(frame.cwd)
    )
      throw new Error("Invalid Crush socket initialization")
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "c-"))
    await fs.chmod(directory, 0o700)
    socketPath = path.join(directory, "s")
    if (Buffer.byteLength(socketPath) > 100)
      throw new Error("Crush socket path exceeds the Unix limit")
    child = spawn(frame.command, ["server", "--host", `unix://${socketPath}`], {
      cwd: frame.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout?.on("data", () => {})
    child.stderr?.on("data", () => {})
    let childFailure: Error | undefined
    child.once("error", () => {
      childFailure = new Error("Crush child failed to start")
    })
    child.once("exit", () => {
      if (!closing) {
        childFailure = new Error("Crush child exited")
        void send({ type: "error" }).catch(() => {})
        void close()
      }
    })
    const deadline = Date.now() + 12_000
    for (;;) {
      if (childFailure || closing) throw childFailure ?? new Error("Crush bridge closed")
      const healthy = await new Promise<boolean>((resolve) => {
        const req = http.request(
          { socketPath, path: "/v1/health", method: "GET", timeout: 1000 },
          (res) => {
            res.resume()
            resolve(res.statusCode === 200)
          }
        )
        req.once("error", () => resolve(false))
        req.once("timeout", () => {
          req.destroy()
          resolve(false)
        })
        req.end()
      })
      if (healthy) break
      if (Date.now() >= deadline) throw new Error("Crush private service startup timed out")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await send({ type: "ready" })
  }
  let buffer = ""
  const decoder = new TextDecoder()
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true })
    if (buffer.length > CRUSH_SOCKET_FRAME_LIMIT && !buffer.includes("\n")) {
      void close()
      process.exitCode = 1
      process.stdin.destroy()
      return
    }
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line)
        void receive(line).catch(async () => {
          await send({ type: "error" }).catch(() => {})
          await close()
          process.exitCode = 1
        })
    }
  })
  process.stdin.on("end", () => {
    void close().catch(() => {})
    if (buffer.trim()) process.exitCode = 1
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close().finally(() => process.exit(signal === "SIGINT" ? 130 : 143))
    })
}
if (process.argv.includes("--cognia-crush-bridge"))
  void startCrushNodeBridge().catch(() => {
    process.stderr.write("Crush private bridge startup failed\n")
    process.exitCode = 1
  })
