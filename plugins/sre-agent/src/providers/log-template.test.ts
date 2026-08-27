import type { SreLogEvidence } from "../evidence"
import { LOG_EVIDENCE } from "../fixtures"
import { logTemplate, maskText, maskToken, TEMPLATE_MASK, templateId } from "./log-template"

function logById(id: string): SreLogEvidence {
  const record = LOG_EVIDENCE.find((entry) => entry.id === id)
  if (!record) throw new Error(`fixture log ${id} is missing`)
  return record
}

describe("maskToken", () => {
  it.each([
    ["45184", TEMPLATE_MASK],
    ["12:02:20", TEMPLATE_MASK],
    ["08-04", TEMPLATE_MASK],
    ["18342.1", TEMPLATE_MASK],
  ])("masks the all-numeric token %s", (token, expected) => {
    expect(maskToken(token)).toBe(expected)
  })

  it("keeps tokens that carry no digits", () => {
    expect(maskToken("scheduler")).toBe("scheduler")
    expect(maskToken("")).toBe("")
  })

  it("masks digit runs inside a mixed token and collapses adjacent masks", () => {
    expect(maskToken("scheduler.py:391]")).toBe(`scheduler.py:${TEMPLATE_MASK}]`)
    expect(maskToken("72.0%")).toBe(`${TEMPLATE_MASK}%`)
  })

  it("normalises a whole line", () => {
    expect(maskText("  WARNING 08-04 12:02:20 scheduler.py:391] Sequence group  ")).toBe(
      `WARNING ${TEMPLATE_MASK} ${TEMPLATE_MASK} scheduler.py:${TEMPLATE_MASK}] Sequence group`
    )
  })
})

describe("logTemplate", () => {
  it("templates a JSON record on its masked key set", () => {
    expect(logTemplate(logById("log_003"))).toBe(
      `gateway provider.timeout attempt=${TEMPLATE_MASK} error_class=${TEMPLATE_MASK} model=${TEMPLATE_MASK} provider=${TEMPLATE_MASK} trace_id=${TEMPLATE_MASK} upstream_latency_ms=${TEMPLATE_MASK}`
    )
  })

  it("separates two records of the same event that carry different keys", () => {
    const timeout = logTemplate(logById("log_003"))
    const fallback = logTemplate(logById("log_004"))
    expect(timeout).not.toBe(fallback)
  })

  it("groups two records that share an event and a key set", () => {
    const [first, second] = [logById("log_maas_001"), logById("log_maas_002")]
    // Same service, different event names — the event is part of the template.
    expect(logTemplate(first)).not.toBe(logTemplate(second))
    const twin: SreLogEvidence = { ...first, id: "log_maas_099", time: "2026-08-04T12:03:00.000Z" }
    expect(logTemplate(twin)).toBe(logTemplate(first))
  })

  it("masks unstructured vLLM lines instead of key sets", () => {
    expect(logTemplate(logById("log_vllm_001"))).toBe(
      `WARNING ${TEMPLATE_MASK} ${TEMPLATE_MASK} scheduler.py:${TEMPLATE_MASK}] Sequence group waiting too long in queue`
    )
  })

  it("falls back to a serialised record when a text log carries a structured raw", () => {
    const record = { ...logById("log_vllm_001"), raw: { note: 7 } } as unknown as SreLogEvidence
    expect(logTemplate(record)).toContain(TEMPLATE_MASK)
  })

  it("survives a JSON record with no keys beyond the prefix set", () => {
    const record = {
      ...logById("log_001"),
      raw: { ts: "2026-08-04T12:02:09.113Z", service: "gateway", event: "request.accepted" },
    } as unknown as SreLogEvidence
    expect(logTemplate(record)).toBe("gateway request.accepted")
  })
})

describe("templateId", () => {
  it("is stable and distinct per template", () => {
    expect(templateId("a b")).toBe(templateId("a b"))
    expect(templateId("a b")).not.toBe(templateId("a c"))
    expect(templateId("")).toMatch(/^tpl_/)
  })
})
