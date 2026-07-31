#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export function parseTraceText(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  const events = []

  for (const [index, line] of lines.entries()) {
    try {
      const batch = JSON.parse(line)
      if (Array.isArray(batch)) events.push(...batch)
    } catch (error) {
      // Next appends a batch only after it is complete, but reading while the
      // dev server is writing can still catch a partial final line.
      if (index === lines.length - 1) continue
      throw new Error(`Invalid trace batch on line ${index + 1}`, { cause: error })
    }
  }

  return events
}

export function summarizeSessions(events) {
  const sessions = new Map()

  for (const event of events) {
    if (!event?.traceId) continue
    let session = sessions.get(event.traceId)
    if (!session) {
      session = {
        traceId: event.traceId,
        startedAt: Number.POSITIVE_INFINITY,
        compileDurationMs: null,
        peakRssBytes: null,
        peakHeapBytes: null,
      }
      sessions.set(event.traceId, session)
    }

    if (event.name === "start-dev-server") {
      session.startedAt = Math.min(session.startedAt, event.startTime ?? session.startedAt)
    }
    if (event.name === "compile-path" && event.tags?.trigger === "/") {
      const durationMs = event.duration / 1_000
      session.compileDurationMs = Math.max(session.compileDurationMs ?? 0, durationMs)
    }
    if (event.name === "memory-usage") {
      const rss = Number(event.tags?.["memory.rss"])
      const heap = Number(event.tags?.["memory.heapUsed"])
      if (Number.isFinite(rss)) session.peakRssBytes = Math.max(session.peakRssBytes ?? 0, rss)
      if (Number.isFinite(heap)) {
        session.peakHeapBytes = Math.max(session.peakHeapBytes ?? 0, heap)
      }
    }
  }

  return [...sessions.values()]
    .filter((session) => Number.isFinite(session.startedAt))
    .sort((left, right) => left.startedAt - right.startedAt)
}

function seconds(value) {
  return value === null ? "—" : (value / 1_000).toFixed(1)
}

function gibibytes(value) {
  return value === null ? "—" : (value / 1024 ** 3).toFixed(2)
}

function main() {
  const json = process.argv.includes("--json")
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"))
  const tracePath = path.resolve(positional[0] ?? ".next/dev/trace")

  if (!fs.existsSync(tracePath)) {
    console.error(`Next dev trace not found: ${tracePath}`)
    console.error("Run pnpm dev, request the route you want to measure, then retry.")
    process.exitCode = 1
    return
  }

  const sessions = summarizeSessions(parseTraceText(fs.readFileSync(tracePath, "utf8")))
  if (json) {
    console.log(JSON.stringify({ tracePath, sessions }, null, 2))
    return
  }

  console.log(`Next dev trace: ${tracePath}`)
  console.log("RSS includes native Turbopack memory; heap is the JavaScript heap only.")
  console.table(
    sessions.slice(-8).map((session) => ({
      trace: session.traceId.slice(0, 8),
      "root compile (s)": seconds(session.compileDurationMs),
      "peak RSS (GiB)": gibibytes(session.peakRssBytes),
      "peak heap (GiB)": gibibytes(session.peakHeapBytes),
    }))
  )
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
