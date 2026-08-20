import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { ACTIVE_EDITOR_REDACTED_REASON, screenActiveEditorContext } from "./active-editor-screen"
import type { ActiveEditorContext } from "./project-editor-bridge"

const CONTEXT: ActiveEditorContext = {
  path: "/repo/src/index.ts",
  selection: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 12 },
  selectedText: "const x = 1",
  diagnostics: [{ message: "unused", severity: "warning", line: 3, column: 7 }],
  openEditors: ["/repo/src/index.ts", "/repo/src/other.ts"],
}

const allow = () => true
const deny = () => false

describe("a snapshot the gate accepts", () => {
  it("passes through whole, tagged as not redacted", () => {
    const screened = screenActiveEditorContext(CONTEXT, allow)
    expect(screened).toEqual({ redacted: false, ...CONTEXT })
  })

  it("keeps the discriminant narrowable", () => {
    const screened = screenActiveEditorContext(CONTEXT, allow)
    if (screened.redacted) throw new Error("expected a clean pass")
    expect(screened.selectedText).toBe("const x = 1")
  })
})

describe("a snapshot the gate rejects", () => {
  const screened = screenActiveEditorContext(CONTEXT, deny)

  it("withholds every text-bearing field", () => {
    // Whole-field withholding, not in-place redaction: partially rewritten code
    // presented as "what the user is looking at" would make a consumer produce
    // edits against text that does not exist in the file.
    expect(screened).not.toHaveProperty("selectedText")
    expect(screened).not.toHaveProperty("path")
    expect(screened).not.toHaveProperty("diagnostics")
    expect(screened).not.toHaveProperty("openEditors")
  })

  it("keeps the positional shape, which carries no content", () => {
    if (!screened.redacted) throw new Error("expected a trip")
    expect(screened.selection).toEqual(CONTEXT.selection)
    expect(screened.openEditorCount).toBe(2)
  })

  it("explains itself with the one shared reason string", () => {
    if (!screened.redacted) throw new Error("expected a trip")
    expect(screened.reason).toBe(ACTIVE_EDITOR_REDACTED_REASON)
  })
})

describe("against the production gate", () => {
  // The consumers inject `hasNoLeakingPiiDeep`; exercising it here is what makes
  // the two call sites' shared policy meaningful rather than stub-shaped.
  it("lets ordinary source through", () => {
    expect(screenActiveEditorContext(CONTEXT, hasNoLeakingPiiDeep).redacted).toBe(false)
  })

  it("trips on an email in the selected text", () => {
    const screened = screenActiveEditorContext(
      { ...CONTEXT, selectedText: 'const owner = "alice.smith@example.com"' },
      hasNoLeakingPiiDeep
    )
    expect(screened.redacted).toBe(true)
  })

  it("trips on PII hiding in a diagnostic message, not just the selection", () => {
    // Diagnostics are compiler/linter output but quote user code back verbatim,
    // so they are as much a leak surface as the selection is.
    const screened = screenActiveEditorContext(
      {
        ...CONTEXT,
        diagnostics: [
          { message: 'unused: "bob@example.com"', severity: "error", line: 9, column: 1 },
        ],
      },
      hasNoLeakingPiiDeep
    )
    expect(screened.redacted).toBe(true)
  })
})

describe("an empty editor", () => {
  it("reports zero open editors when withheld", () => {
    const empty: ActiveEditorContext = {
      path: null,
      selection: null,
      selectedText: null,
      diagnostics: [],
      openEditors: [],
    }
    const screened = screenActiveEditorContext(empty, deny)
    if (!screened.redacted) throw new Error("expected a trip")
    expect(screened.openEditorCount).toBe(0)
    expect(screened.selection).toBeNull()
  })
})
