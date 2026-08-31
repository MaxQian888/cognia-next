import { DIGITAL_TWIN_DISCLOSURE, twinShareProvenance } from "@/lib/twin/outbound-disclosure"
import { enforceExportDisclosure } from "./disclosure"

describe("enforceExportDisclosure", () => {
  const provenance = twinShareProvenance("twin-1")

  it.each(["markdown", "text"] as const)("adds a visible marker to %s", (format) => {
    const output = enforceExportDisclosure("Answer", format, provenance)
    expect(output).toContain(DIGITAL_TWIN_DISCLOSURE)
    expect(output).toContain(`Cognia-Provenance: ${JSON.stringify(provenance)}`)
  })

  it("adds visible and structured disclosure to JSON", () => {
    const parsed = JSON.parse(enforceExportDisclosure('{"messages":[]}', "json", provenance))
    expect(parsed.disclosure).toBe(DIGITAL_TWIN_DISCLOSURE)
    expect(parsed.cogniaProvenance).toEqual(provenance)
  })

  it("injects a visible HTML disclosure once", () => {
    const once = enforceExportDisclosure("<main>Answer</main>", "html", provenance)
    expect(once).toContain('data-cognia-provenance="digital-twin"')
    expect(once).toContain("data-cognia-provenance-json")
    expect(once).toContain('"sourceId":"twin-1"')
    expect(enforceExportDisclosure(once, "html", provenance)).toBe(once)
  })

  it("replaces spoofed or partially stripped sentinels with exact host data", () => {
    const html = enforceExportDisclosure(
      '<main>Answer<script data-cognia-provenance-json>{"fake":true}</script></main>',
      "html",
      provenance
    )
    expect(html).toContain(DIGITAL_TWIN_DISCLOSURE)
    expect(html).toContain('"sourceId":"twin-1"')
    expect(html).not.toContain('"fake":true')

    const text = enforceExportDisclosure(
      'Answer\nCognia-Provenance: [{"sourceId":"fake"}]',
      "text",
      provenance
    )
    expect(text).toContain(DIGITAL_TWIN_DISCLOSURE)
    expect(text).toContain('"sourceId":"twin-1"')
    expect(text).not.toContain('"sourceId":"fake"')
  })

  it("fails closed when transformed JSON cannot be repaired", () => {
    expect(() => enforceExportDisclosure("not json", "json", provenance)).toThrow(/malformed JSON/)
  })

  it("leaves ordinary exports unchanged", () => {
    expect(enforceExportDisclosure("Answer", "text", undefined)).toBe("Answer")
  })
})
