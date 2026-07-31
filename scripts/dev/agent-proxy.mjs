#!/usr/bin/env node

import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import tls from "node:tls"
import { fileURLToPath } from "node:url"

const EXIT_USAGE = 2
const EXIT_PREFLIGHT = 3
const PROBE_TIMEOUT_MS = 5_000
const SELF_TEST_FLAG = "--self-test-child"
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), "../..")

class UsageError extends Error {}
class PreflightError extends Error {}

function help() {
  return `Usage:
  AGENT_PROXY_URL=http://127.0.0.1:7890 pnpm agent:proxy -- <command> [arguments]
  AGENT_PROXY_URL=http://127.0.0.1:7890 pnpm agent:proxy --check

Options:
  --check     Verify the proxy and the macOS direct-connect block, then exit.
  --dry-run   Print the redacted launch configuration without connecting.
  --help      Show this help.

The proxy must be a loopback HTTP or HTTPS proxy. Credentials belong in
AGENT_PROXY_URL, not command-line arguments, so they do not appear in the process
list. Agents must honor standard HTTP proxy variables; agents that do not are
blocked instead of falling back to a direct connection. Set
AGENT_PROXY_CHECK_TARGET=host:port to change the TLS-capable CONNECT preflight target.`
}

function parseCli(argv) {
  let check = false
  let dryRun = false
  const target = []
  let forwarding = false
  for (const arg of argv) {
    if (forwarding) {
      target.push(arg)
    } else if (arg === "--") {
      forwarding = true
    } else if (arg === "--check") {
      check = true
    } else if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, check: false, dryRun: false, command: undefined, commandArgs: [] }
    } else {
      target.push(arg)
    }
  }
  if (check && dryRun) throw new UsageError("--check and --dry-run cannot be combined")
  const [command, ...commandArgs] = target
  if (!check && !command) {
    throw new UsageError("Missing agent command after `--`")
  }
  return { help: false, check, dryRun, command, commandArgs }
}

function configuredProxy(env) {
  return (env.AGENT_PROXY_URL || "").trim()
}

function parseProxy(raw) {
  if (!raw) {
    throw new UsageError(
      "No proxy configured. Set AGENT_PROXY_URL, for example http://127.0.0.1:7890."
    )
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new UsageError("AGENT_PROXY_URL is not a valid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError("The fail-closed launcher requires an HTTP or HTTPS proxy")
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new UsageError(
      "The fail-closed launcher requires a loopback proxy (localhost, 127.0.0.1, or ::1)"
    )
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new UsageError("The proxy URL must not contain a path, query, or fragment")
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError("The proxy URL has an invalid port")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  return { raw, url, host, port }
}

function redactedProxy(proxy) {
  const safe = new URL(proxy.raw)
  if (safe.username) safe.username = "***"
  if (safe.password) safe.password = "***"
  return safe.toString().replace(/\/$/, "")
}

function proxyEnvironment(env, proxyUrl) {
  return {
    ...env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
  }
}

function connectSocket(proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = { host: proxy.host, port: proxy.port }
    const socket =
      proxy.url.protocol === "https:"
        ? tls.connect({
            ...options,
            servername: net.isIP(proxy.host) ? undefined : proxy.host,
          })
        : net.connect(options)
    const readyEvent = proxy.url.protocol === "https:" ? "secureConnect" : "connect"
    const fail = (error) => {
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error("proxy connection timed out")))
    socket.once("error", fail)
    socket.once(readyEvent, () => {
      socket.removeListener("error", fail)
      resolve(socket)
    })
  })
}

function parseCheckTarget(raw = "example.com:443") {
  let url
  try {
    url = new URL(`tcp://${raw}`)
  } catch {
    throw new UsageError("AGENT_PROXY_CHECK_TARGET must use host:port format")
  }
  const port = Number(url.port)
  if (
    !url.hostname ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new UsageError("AGENT_PROXY_CHECK_TARGET must use host:port format")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (/[\r\n]/.test(host)) throw new UsageError("AGENT_PROXY_CHECK_TARGET contains invalid data")
  const authority = net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`
  return { authority, host }
}

async function probeTunnel(proxy, target) {
  let socket
  let tunnel
  try {
    socket = await connectSocket(proxy, PROBE_TIMEOUT_MS)
    const auth =
      proxy.url.username || proxy.url.password
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxy.url.username)}:${decodeURIComponent(proxy.url.password)}`
          ).toString("base64")}\r\n`
        : ""
    socket.write(`CONNECT ${target.authority} HTTP/1.1\r\nHost: ${target.authority}\r\n${auth}\r\n`)
    const response = await new Promise((resolve, reject) => {
      let received = Buffer.alloc(0)
      const cleanup = () => {
        socket.removeListener("data", onData)
        socket.removeListener("error", fail)
        socket.removeListener("end", onEnd)
      }
      const fail = (error) => {
        cleanup()
        reject(error)
      }
      const onData = (chunk) => {
        received = Buffer.concat([received, chunk])
        if (received.length > 16_384) return fail(new Error("proxy response header is too large"))
        const headerEnd = received.indexOf("\r\n\r\n")
        if (headerEnd === -1) return
        cleanup()
        resolve({
          header: received.subarray(0, headerEnd).toString("latin1"),
          remainder: received.subarray(headerEnd + 4),
        })
      }
      const onEnd = () => fail(new Error("proxy closed before CONNECT completed"))
      socket.setTimeout(PROBE_TIMEOUT_MS, () => fail(new Error("proxy CONNECT timed out")))
      socket.on("data", onData)
      socket.once("error", fail)
      socket.once("end", onEnd)
    })
    const firstLine = response.header.slice(0, response.header.indexOf("\r\n"))
    const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(firstLine)?.[1]
    if (!status || Number(status) < 200 || Number(status) >= 300) {
      throw new Error(`CONNECT returned ${status ?? "an invalid response"}`)
    }
    if (response.remainder.length > 0) socket.unshift(response.remainder)
    tunnel = tls.connect({
      socket,
      servername: net.isIP(target.host) ? undefined : target.host,
      // This probe verifies tunnel transport, not endpoint identity. The agent
      // performs its own ordinary certificate validation for real requests.
      rejectUnauthorized: false,
    })
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error)
      tunnel.setTimeout(PROBE_TIMEOUT_MS, () => fail(new Error("tunnel TLS handshake timed out")))
      tunnel.once("secureConnect", resolve)
      tunnel.once("error", fail)
      tunnel.once("end", () => fail(new Error("tunnel closed before TLS handshake completed")))
    })
  } catch (error) {
    throw new PreflightError(`Proxy preflight failed: ${error.message}`)
  } finally {
    tunnel?.destroy()
    socket?.destroy()
  }
}

async function executable(candidate) {
  try {
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findLauncher() {
  const name = "cognia-agent-proxy-launcher"
  const candidates = [
    path.join(repoRoot, "target", "debug", name),
    path.join(repoRoot, "target", "release", name),
  ]
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate
  }
  throw new UsageError(
    "The native network sandbox launcher is missing. Run `pnpm agent:proxy` from the repository so its script can build it."
  )
}

function launcherArgs(proxyPort, target, targetArgs = []) {
  return ["--proxy-port", String(proxyPort), "--", target, ...targetArgs]
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
}

async function startForbiddenServer() {
  const server = net.createServer((socket) => socket.end())
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server
}

async function probeSandbox(launcher, proxy) {
  const forbidden = await startForbiddenServer()
  const forbiddenPort = forbidden.address().port
  try {
    const result = await spawnAndWait(
      launcher,
      launcherArgs(proxy.port, process.execPath, [scriptPath, SELF_TEST_FLAG]),
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENT_PROXY_SELF_TEST_ALLOWED_HOST: proxy.host,
          AGENT_PROXY_SELF_TEST_ALLOWED_PORT: String(proxy.port),
          AGENT_PROXY_SELF_TEST_DENIED_PORT: String(forbiddenPort),
        },
        stdio: ["ignore", "ignore", "pipe"],
      }
    )
    if (result.code !== 0) {
      throw new PreflightError(
        "Network sandbox self-test failed: direct connections were not proven to be blocked"
      )
    }
  } finally {
    await new Promise((resolve) => forbidden.close(resolve))
  }
}

function tryLocalConnection(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const finish = (connected) => {
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

async function runSelfTestChild() {
  const allowedHost = process.env.AGENT_PROXY_SELF_TEST_ALLOWED_HOST
  const allowedPort = Number(process.env.AGENT_PROXY_SELF_TEST_ALLOWED_PORT)
  const deniedPort = Number(process.env.AGENT_PROXY_SELF_TEST_DENIED_PORT)
  if (!allowedHost || !(await tryLocalConnection(allowedHost, allowedPort))) {
    process.exit(EXIT_PREFLIGHT)
  }
  if (await tryLocalConnection("127.0.0.1", deniedPort)) process.exit(EXIT_PREFLIGHT)
}

async function main() {
  if (process.argv[2] === SELF_TEST_FLAG) {
    await runSelfTestChild()
    return
  }

  const cli = parseCli(process.argv.slice(2))
  if (cli.help) {
    process.stdout.write(`${help()}\n`)
    return
  }
  if (process.platform !== "darwin") {
    throw new UsageError(
      "Fail-closed proxy launching currently requires macOS Seatbelt; this command will not fall back to environment variables alone"
    )
  }

  const proxy = parseProxy(configuredProxy(process.env))
  const checkTarget = parseCheckTarget(process.env.AGENT_PROXY_CHECK_TARGET)
  const launcher = await findLauncher()
  const args = cli.command ? launcherArgs(proxy.port, cli.command, cli.commandArgs) : undefined
  if (cli.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          proxy: redactedProxy(proxy),
          launcher,
          command: [cli.command, ...cli.commandArgs],
          directConnections: "blocked",
        },
        null,
        2
      )}\n`
    )
    return
  }

  await probeTunnel(proxy, checkTarget)
  await probeSandbox(launcher, proxy)
  if (cli.check) {
    process.stdout.write(
      `Agent proxy is ready: ${redactedProxy(proxy)}; direct connections are blocked.\n`
    )
    return
  }

  const result = await spawnAndWait(launcher, args, {
    cwd: process.cwd(),
    env: proxyEnvironment(process.env, proxy.raw),
    stdio: "inherit",
  })
  if (result.signal) process.kill(process.pid, result.signal)
  process.exitCode = result.code ?? 1
}

main().catch((error) => {
  const prefix = error instanceof UsageError ? "Usage error" : "Preflight error"
  process.stderr.write(`${prefix}: ${error.message}\n`)
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_PREFLIGHT
})
