/** @jest-environment node */
import { validateContentPart } from "./content-part-policy"

describe("validateContentPart", () => {
  it("allows local/session artifacts and HTTPS references", () => {
    for (const uri of [
      "/tmp/report.txt",
      "C:\\tmp\\report.txt",
      "file:///tmp/report.txt",
      "artifact://session/report.txt",
      "session://s1/report.txt",
      "https://trusted.test/report.txt",
    ]) {
      expect(validateContentPart({ type: "file", name: "report", uri }).ok).toBe(true)
    }
  })

  it("rejects data/base64, executable, and insecure remote URI schemes", () => {
    for (const uri of [
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "http://remote.test/a",
    ]) {
      expect(validateContentPart({ type: "file", name: "bad", uri }).ok).toBe(false)
    }
  })

  it("sanitizes previews and validates A2UI at the ingestion boundary", () => {
    const file = validateContentPart({
      type: "file",
      name: "safe",
      uri: "artifact://s/a",
      preview: "hello\u001b[2Jworld",
    })
    expect(file).toMatchObject({ ok: true, part: { preview: "helloworld" } })
    expect(
      validateContentPart({
        type: "a2ui",
        surfaceId: "s",
        source: "external",
        payload: { rootId: "missing", components: {} },
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining("components") })
  })

  it("keeps an A2UI surface's computed declarations for the overlay (ADR-0240)", () => {
    const computed = { "/total": { op: "multiply", args: [{ path: "/qty" }, { path: "/price" }] } }
    const result = validateContentPart({
      type: "a2ui",
      surfaceId: "cart",
      source: "mcp-bridge",
      payload: {
        rootId: "root",
        components: { root: { id: "root", component: "Text", text: "x" } },
        dataModel: { qty: 2, price: 3 },
        computed,
      },
    })
    expect(result).toMatchObject({
      ok: true,
      part: { payload: { dataModel: { qty: 2, price: 3, total: 6 }, computed } },
    })
  })
})
