#!/usr/bin/env node

/** Loopback-only development entry that discovers and opens the live App-owned relay UI. */

import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"

import {
  corsHeadersForOrigin,
  parseCommonOptions,
  readJson,
  readSecret,
  relayPaths,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const options = parseCommonOptions(argv)
const webPortIndex = argv.indexOf("--web-port")
const webPort = webPortIndex >= 0 ? Number(argv[webPortIndex + 1]) : 4317
if (!Number.isSafeInteger(webPort) || webPort < 1024 || webPort > 65535) {
  throw new Error(`Invalid Web port: ${webPort}`)
}
const paths = relayPaths(options.stateDir)
const pairingCode = process.env.COGNIA_CODEX_PAIRING_CODE ?? randomBytes(18).toString("base64url")
const allowedOrigins = new Set(
  (process.env.COGNIA_WEB_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
)

function pairingCodeMatches(value) {
  if (typeof value !== "string") return false
  const actual = Buffer.from(value)
  const expected = Buffer.from(pairingCode)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function relayDestination() {
  const [state, token] = await Promise.all([readJson(paths.state), readSecret(paths.token)])
  const port = state?.port ?? options.port
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(1500),
  }).catch(() => null)
  if (!response?.ok) throw new Error("The App-owned relay is not running")
  return { port, token, url: `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}` }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${webPort}`)
  const corsHeaders = corsHeadersForOrigin(allowedOrigins, request.headers.origin)
  if (requestUrl.pathname === "/api/pair") {
    if (Object.keys(corsHeaders).length === 0) {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(JSON.stringify({ error: "origin_not_allowed" }))
      return
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders)
      response.end()
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405, { ...corsHeaders, allow: "POST, OPTIONS" })
      response.end()
      return
    }
    if (!pairingCodeMatches(request.headers["x-cognia-pairing-code"])) {
      response.writeHead(401, {
        ...corsHeaders,
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      response.end(JSON.stringify({ error: "invalid_pairing_code" }))
      return
    }
    try {
      const destination = await relayDestination()
      response.writeHead(200, {
        ...corsHeaders,
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      response.end(
        JSON.stringify({
          relayBaseUrl: `http://127.0.0.1:${destination.port}`,
          token: destination.token,
        })
      )
    } catch (error) {
      response.writeHead(503, {
        ...corsHeaders,
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      response.end(JSON.stringify({ error: error.message }))
    }
    return
  }
  if (request.url === "/healthz") {
    try {
      const destination = await relayDestination()
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      response.end(JSON.stringify({ status: "ready", relay: destination.port }))
    } catch (error) {
      response.writeHead(503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      response.end(JSON.stringify({ status: "unavailable", error: error.message }))
    }
    return
  }
  try {
    const destination = await relayDestination()
    response.writeHead(302, { location: destination.url, "cache-control": "no-store" })
    response.end()
  } catch (error) {
    response.writeHead(503, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    })
    response.end(
      `<!doctype html><title>Cognia Codex relay</title><main><h1>Relay unavailable</h1><p>${String(error.message).replace(/[<>&]/g, "")}</p><p>Launch Codex App through the prepared relay before refreshing this page.</p></main>`
    )
  }
})

server.listen(webPort, "127.0.0.1", () => {
  process.stdout.write(
    [
      `Cognia Codex Web is ready at http://127.0.0.1:${webPort}`,
      `Cognia Web pairing code: ${pairingCode}`,
    ].join("\n") + "\n"
  )
})
