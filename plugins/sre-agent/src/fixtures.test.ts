/** @jest-environment node */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  EXPECTED_TIMELINE,
  FIXTURE_SOURCE_TEXT,
  parseJsonLogEvidence,
  parsePrometheusEvidence,
  parseVllmLogEvidence,
} from "./fixtures"

const fixtureRoot = join(__dirname, "../fixtures/qwen-timeout-fallback")
const readFixture = (name: string): string =>
  readFileSync(join(fixtureRoot, name), "utf8").trimEnd()

describe("SRE golden fixture sources", () => {
  it.each([
    ["gateway.logs.jsonl", "gatewayLogs"],
    ["maas.logs.jsonl", "maasLogs"],
    ["metrics.prom", "metrics"],
    ["vllm.stdout.log", "vllmLogs"],
    ["runbook.md", "runbook"],
  ] as const)("keeps bundled %s synchronized", (file, source) => {
    expect(FIXTURE_SOURCE_TEXT[source]).toBe(readFixture(file))
  })

  it("parses JSONL, text logs, and Prometheus exposition from the checked-in files", () => {
    expect(parseJsonLogEvidence(readFixture("gateway.logs.jsonl"), "log")).toHaveLength(5)
    expect(parseJsonLogEvidence(readFixture("maas.logs.jsonl"), "log_maas")).toHaveLength(2)
    expect(parseVllmLogEvidence(readFixture("vllm.stdout.log"))).toHaveLength(2)
    expect(parsePrometheusEvidence(readFixture("metrics.prom"))).toHaveLength(3)
  })

  it("handles optional log identifiers and unlabeled metrics", () => {
    const logs = parseJsonLogEvidence(
      '{"ts":"2026-08-04T12:02:00.000Z","level":"info","service":"worker","event":"started"}',
      "log_worker"
    )
    expect(logs[0]).toMatchObject({ traceId: undefined, requestId: undefined })
    expect(parsePrometheusEvidence("gateway_llm_fallbacks_total 1")[0].labels).toEqual({})
    expect(parseVllmLogEvidence("ERROR 08-04 12:02:22 engine.py:1] failed")[0].level).toBe("error")
  })

  it("rejects malformed raw fixture outlets", () => {
    expect(() => parseVllmLogEvidence("not a vLLM log")).toThrow("invalid vLLM log line")
    expect(() => parsePrometheusEvidence("not prometheus")).toThrow("invalid Prometheus sample")
    expect(() => parsePrometheusEvidence("unknown_metric 1")).toThrow("unsupported fixture metric")
  })

  it("pins the required golden timeline and answer contract", () => {
    expect(EXPECTED_TIMELINE.map((row) => row.evidenceIds)).toEqual([
      ["log_001"],
      ["log_002"],
      ["log_003", "span_002", "span_004"],
      ["log_004", "metric_001"],
      ["log_005", "span_005"],
    ])
    const answer = readFixture("expected.answer.md")
    expect(answer).toContain("request acceptance")
    expect(answer).toContain("fallback to qwen-vllm-b")
    expect(answer).toContain("status=200")
    expect(answer).toContain("evidence ids")
  })
})
