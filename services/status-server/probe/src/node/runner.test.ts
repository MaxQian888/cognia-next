import { mkdtemp, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import type { ObservationBatch } from "../../../../../lib/status/contract"
import { createStatusFixture } from "../../../../../lib/status/fixtures"
import { verifyProbeRequest } from "../../../../../lib/status/signing"
import { parseObservationBatch } from "../../../../../lib/status/validate"
import { FakeRelay, type FakeRelayOptions } from "../testing/fake-relay"
import { parseProbeConfig, type ProbeConfig } from "./config"
import type { FetchLike } from "./http"
import { memoryLogger } from "./logger"
import { ProbeRunner } from "./runner"

const SECRET = new Uint8Array(32).fill(9)
const API = "https://status.example.test/api/status/v1"
const PAGE = "https://status.example.test/status/"
// The spool drops anything older than 10 minutes by wall clock, so runs are
// scheduled at the current minute.
const MINUTE = Date.now() - (Date.now() % 60_000)

async function config(): Promise<ProbeConfig> {
  const spoolDir = await mkdtemp(path.join(os.tmpdir(), "probe-runner-"))
  return parseProbeConfig({
    apiBase: API,
    probeId: "ext-test",
    keyId: "ext-test-k1",
    secretFile: "/dev/null",
    signalingUrl: "wss://signaling.example.test/signaling",
    registryRevision: 4,
    profiles: [
      { id: "native", origin: null, httpCadenceSeconds: 60, protocolCadenceSeconds: 60 },
      {
        id: "web",
        origin: "https://cognia.cn",
        httpCadenceSeconds: null,
        protocolCadenceSeconds: 300,
      },
    ],
    statusPageUrl: PAGE,
    spoolDir,
    alertWebhook: "https://alerts.example.test/hook",
  })
}

interface World {
  runner: ProbeRunner
  relay: FakeRelay
  ingested: Array<{ batch: ObservationBatch; headers: Headers; body: Uint8Array }>
  alerts: string[]
  statusApiHealthy: { value: boolean }
  logger: ReturnType<typeof memoryLogger>
  cfg: ProbeConfig
}

async function world(relayOptions: FakeRelayOptions = {}, ingestStatus = 202): Promise<World> {
  const cfg = await config()
  const relay = new FakeRelay({ allowedOrigins: ["https://cognia.cn"], ...relayOptions })
  const ingested: World["ingested"] = []
  const alerts: string[] = []
  const statusApiHealthy = { value: true }
  const logger = memoryLogger()
  const fetchImpl: FetchLike = async (url, init) => {
    const target = String(url)
    if (target === PAGE) {
      return new Response("<!doctype html><html><head></head></html>", {
        headers: { "content-type": "text/html" },
      })
    }
    if (target === `${API}/healthz`) {
      return statusApiHealthy.value
        ? Response.json({ ok: true })
        : new Response(null, { status: 502 })
    }
    if (target === `${API}/snapshot?range=24h`)
      return Response.json(createStatusFixture("operational", "24h"))
    if (target === `${API}/observations`) {
      const body = new Uint8Array(init?.body as Uint8Array)
      ingested.push({
        batch: JSON.parse(Buffer.from(body).toString("utf8")) as ObservationBatch,
        headers: new Headers(init?.headers),
        body,
      })
      return Response.json({ status: "accepted" }, { status: ingestStatus })
    }
    if (target === "https://alerts.example.test/hook") {
      alerts.push(String((JSON.parse(String(init?.body)) as { key: string }).key))
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  }
  const runner = new ProbeRunner({
    config: cfg,
    secret: SECRET,
    transport: relay,
    logger,
    fetchImpl,
  })
  await runner.spool.init()
  return { runner, relay, ingested, alerts, statusApiHealthy, logger, cfg }
}

describe("ProbeRunner.runOnce", () => {
  it("runs native checks plus monitoring-plane checks and ingests one signed batch", async () => {
    const w = await world()
    await w.runner.runOnce(w.cfg.profiles[0]!, MINUTE, { runHttp: true, runProtocol: true })
    await w.runner.ingestion.drainDue()
    expect(w.ingested).toHaveLength(1)
    const [{ batch, headers, body }] = w.ingested as [World["ingested"][number]]
    expect(parseObservationBatch(batch).ok).toBe(true)
    expect(batch).toMatchObject({ probeId: "ext-test", registryRevision: 4, profileId: "native" })
    expect(batch.scheduledAt).toBe(new Date(MINUTE).toISOString())
    expect(batch.checks.map((check) => [check.checkId, check.result])).toEqual([
      ["signalingHttp", "pass"],
      ["signalingAuth", "pass"],
      ["relayData", "pass"],
      ["statusPage", "pass"],
      ["statusApi", "pass"],
    ])
    const verdict = await verifyProbeRequest({
      headers,
      method: "POST",
      path: "/api/status/v1/observations",
      body,
      nowMs: Date.now(),
      resolveSecret: () => SECRET,
    })
    expect(verdict.ok).toBe(true)
    expect(w.runner.spool.entries()).toEqual([])
    expect(w.relay.origins).toEqual([null, null])
  })

  it("runs a simulated-Origin profile without monitoring checks", async () => {
    const w = await world()
    await w.runner.runOnce(w.cfg.profiles[1]!, MINUTE, { runHttp: false, runProtocol: true })
    await w.runner.ingestion.drainDue()
    expect(w.ingested[0]?.batch.checks.map((check) => check.checkId)).toEqual([
      "signalingAuth",
      "relayData",
    ])
    expect(w.ingested[0]?.batch.profileId).toBe("web")
    expect(w.relay.origins).toEqual(["https://cognia.cn", "https://cognia.cn"])
  })

  it("submits target failures as evidence (auth fail, data dependency gap)", async () => {
    const w = await world({ rejectRoles: ["mobile"] })
    await w.runner.runOnce(w.cfg.profiles[0]!, MINUTE, { runHttp: true, runProtocol: true })
    await w.runner.ingestion.drainDue()
    const checks = w.ingested[0]!.batch.checks
    expect(checks.find((check) => check.checkId === "signalingAuth")).toMatchObject({
      result: "fail",
      reason: "auth_rejected",
    })
    expect(checks.find((check) => check.checkId === "relayData")).toMatchObject({
      result: "unknown",
      reason: "dependency_failed",
      dependsOn: "signalingAuth",
    })
  })

  it("alerts after three consecutive failing statusApi minutes", async () => {
    const w = await world()
    w.statusApiHealthy.value = false
    for (let minute = 0; minute < 3; minute += 1) {
      await w.runner.runOnce(w.cfg.profiles[0]!, MINUTE + minute * 60_000, {
        runHttp: true,
        runProtocol: false,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(w.alerts).toEqual(["status_api_failing"])
    w.statusApiHealthy.value = true
    await w.runner.runOnce(w.cfg.profiles[0]!, MINUTE + 180_000, {
      runHttp: true,
      runProtocol: false,
    })
    w.statusApiHealthy.value = false
    await w.runner.runOnce(w.cfg.profiles[0]!, MINUTE + 240_000, {
      runHttp: true,
      runProtocol: false,
    })
    expect(w.alerts).toEqual(["status_api_failing"])
  })
})

describe("ProbeRunner lifecycle", () => {
  it("on shutdown aborts the in-flight run without submitting it and keeps spooled batches", async () => {
    const w = await world({ silentSubscribe: true }, 503)
    // A previously failed batch is waiting in the spool.
    const minute = new Date(Date.now() - (Date.now() % 60_000)).toISOString()
    await w.runner.ingestion.enqueue({
      schemaVersion: 1,
      probeId: "ext-test",
      runId: "pending-1",
      registryRevision: 4,
      scheduledAt: minute,
      startedAt: minute,
      finishedAt: minute,
      profileId: "native",
      checks: [
        {
          checkId: "signalingHttp",
          result: "pass",
          durationMs: 1,
          reason: null,
          attempted: true,
          dependsOn: null,
        },
      ],
    })
    await w.runner.start()
    const inFlight = w.runner.runOnce(w.cfg.profiles[0]!, MINUTE, {
      runHttp: false,
      runProtocol: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    await w.runner.stop()
    await inFlight
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(w.ingested.every((entry) => entry.batch.runId === "pending-1")).toBe(true)
    expect(
      w.logger.lines.some((line) => line.event === "observer_gap" && line.reason === "aborted")
    ).toBe(true)
    expect(w.relay.sockets.every((socket) => socket.isClosed)).toBe(true)
    const files = await readdir(w.cfg.spoolDir)
    expect(files.some((name) => name.includes("pending-1"))).toBe(true)
  })
})
