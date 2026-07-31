// Deterministic Anthropic-protocol conformance server (ADR-0090 Phase 4).
//
// A plain node:http server implementing the subset of the Anthropic Messages
// API the Claude Agent SDK / embedded Claude Code exercises:
//   POST /v1/messages            (SSE + buffered)
//   POST /v1/messages/count_tokens
//
// Determinism rules: seeded message ids (msg_conf_<scenario>_<n>), no
// wall-clock randomness, response scripts declared by the scenario. A control
// side channel (/__control/*) exposes the redacted request log and scenario
// phase advancement so tests can assert upstream-visible behavior (which
// credential arrived, whether a request happened at all).
//
// This is TEST FIXTURE code: never bundled, never shipped (tests/ is outside
// every build graph), and vendor-neutral by construction.

import http from "node:http"

import { splitBytes } from "./sse.mjs"

/**
 * @typedef {{
 *   status?: number,
 *   headers?: Record<string, string>,
 *   body?: unknown,
 *   sseFrames?: string[],
 *   splitPoints?: number[],
 *   failMode?: "refuse-connection" | "destroy-after-bytes" | "stall",
 *   destroyAfterBytes?: number,
 * }} ResponsePlan
 *
 * @typedef {{
 *   name?: string,
 *   matches?: (req: { body: any, headers: Record<string, string>, phase: number }) => boolean,
 *   respond: (req: { body: any, headers: Record<string, string>, phase: number, hit: number }) => ResponsePlan,
 * }} ScenarioStep
 */

export class ConformanceServer {
  /**
   * @param {{ scenarioId: string, steps: ScenarioStep[] }} options
   */
  constructor({ scenarioId, steps }) {
    this.scenarioId = scenarioId
    this.steps = steps
    this.phase = 0
    this.hits = []
    this.unmatched = []
    this.messageCounter = 0
    this.server = null
    this.port = 0
  }

  nextMessageId() {
    this.messageCounter += 1
    return `msg_conf_${this.scenarioId}_${this.messageCounter}`
  }

  redactedHit(req, body) {
    return {
      path: req.url,
      apiKey: req.headers["x-api-key"] ?? null,
      authorization: req.headers["authorization"] ? "<present>" : null,
      anthropicVersion: req.headers["anthropic-version"] ?? null,
      anthropicBeta: req.headers["anthropic-beta"] ?? null,
      model: body?.model ?? null,
      stream: body?.stream === true,
      messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
      hasToolResult:
        Array.isArray(body?.messages) &&
        body.messages.some(
          (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === "tool_result")
        ),
      phase: this.phase,
    }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8")
        let body = null
        try {
          body = raw ? JSON.parse(raw) : null
        } catch {
          body = null
        }
        this.route(req, res, body)
      })
    })
    await new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port
        resolve()
      })
    })
    // Plain origin: ANTHROPIC_BASE_URL consumers append /v1/messages
    // themselves; the gateway leg appends /v1 in its deployment endpoint.
    return `http://127.0.0.1:${this.port}`
  }

  route(req, res, body) {
    const url = req.url ?? ""
    if (url.startsWith("/__control/requests")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ hits: this.hits, unmatched: this.unmatched, phase: this.phase }))
      return
    }
    if (url.startsWith("/__control/advance")) {
      this.phase += 1
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ phase: this.phase }))
      return
    }
    if (url.startsWith("/v1/messages/count_tokens")) {
      this.hits.push({ ...this.redactedHit(req, body), countTokens: true })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ input_tokens: 42 }))
      return
    }
    if (url.startsWith("/v1/messages")) {
      const hit = this.redactedHit(req, body)
      this.hits.push(hit)
      const context = {
        body,
        headers: /** @type {Record<string, string>} */ (req.headers),
        phase: this.phase,
        hit: this.hits.length,
      }
      const step = this.steps.find((s) => !s.matches || s.matches(context))
      if (!step) {
        this.unmatched.push(hit)
        res.writeHead(500, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "api_error",
              message: `conformance: no scenario step matched (scenario=${this.scenarioId})`,
            },
          })
        )
        return
      }
      this.respond(res, step.respond(context))
      return
    }
    // The claude-code CLI probes auxiliary endpoints (HEAD /, model checks…).
    // Answer 200 {} — same as the sidecar live-harness mock — so an explicit
    // --model passes the CLI's probe and every /v1/messages call still routes
    // through the deterministic scenario engine above.
    this.hits.push({ path: url, probe: true })
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  }

  /** @param {import("node:http").ServerResponse} res @param {ResponsePlan} plan */
  respond(res, plan) {
    if (plan.failMode === "refuse-connection") {
      res.destroy()
      return
    }
    if (plan.sseFrames) {
      res.writeHead(plan.status ?? 200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...(plan.headers ?? {}),
      })
      const bytes = Buffer.from(plan.sseFrames.join(""), "utf8")
      if (plan.failMode === "destroy-after-bytes") {
        const cut = Math.min(plan.destroyAfterBytes ?? 16, bytes.length)
        // Destroy only after the partial bytes flushed, so the client sees a
        // started-then-severed stream (not a connection-level fetch failure).
        res.write(bytes.subarray(0, cut), () => {
          setImmediate(() => res.destroy())
        })
        return
      }
      for (const piece of splitBytes(bytes, plan.splitPoints ?? [])) {
        res.write(piece)
      }
      if (plan.failMode === "stall") {
        // Keep the socket open without ever finishing the stream.
        return
      }
      res.end()
      return
    }
    const payload = typeof plan.body === "string" ? plan.body : JSON.stringify(plan.body ?? {})
    res.writeHead(plan.status ?? 200, {
      "content-type": "application/json",
      ...(plan.headers ?? {}),
    })
    res.end(payload)
  }

  async close() {
    if (!this.server) return
    await new Promise((resolve) => this.server.close(() => resolve()))
    this.server = null
  }
}

/** Convenience: start a server for a scenario module (`{ id, steps }`). */
export async function createConformanceServer(scenario) {
  const server = new ConformanceServer({ scenarioId: scenario.id, steps: scenario.steps })
  const baseUrl = await server.start()
  return { server, baseUrl }
}
