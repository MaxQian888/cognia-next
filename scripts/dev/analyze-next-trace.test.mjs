import assert from "node:assert/strict"
import { test } from "node:test"

import { buildAnalysisReport } from "./analyze-next-trace.mjs"

test("buildAnalysisReport combines compiler, cache, browser, database, and boot metrics", () => {
  const report = buildAnalysisReport({
    tracePath: "/repo/.next/dev/trace",
    cacheBytes: 1024,
    bootProfile: "main",
    persistentCacheEnabled: false,
    events: [
      { traceId: "trace-1", name: "start-dev-server", startTime: 1 },
      {
        traceId: "trace-1",
        name: "memory-usage",
        tags: { "memory.rss": "2048", "memory.heapUsed": "512" },
      },
    ],
    browserSnapshot: {
      browserHeapBytes: 256,
      decodedJsBytes: 128,
      databaseVersions: { cognia: 144 },
      capabilities: ["core-chat"],
    },
  })

  assert.equal(report.bootProfile, "main")
  assert.equal(report.turbopackCache.persistent, false)
  assert.equal(report.turbopackCache.bytes, 1024)
  assert.equal(report.sessions[0].peakRssBytes, 2048)
  assert.deepEqual(report.browser?.databaseVersions, { cognia: 144 })
  assert.deepEqual(report.browser?.capabilities, ["core-chat"])
})
