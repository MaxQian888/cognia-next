/**
 * Tests for the canonical extension-id rule.
 *
 * The dot and empty-component cases are regression tests for a real
 * install-root escape: the old rule was
 * `replace(/[^A-Za-z0-9._-]/g, "-")` — with `.` in the allowed set — so
 * `publisher: ""` + `name: "."` survived untouched and composed into `".."`.
 */

import {
  canonicalExtensionId,
  InvalidExtensionIdError,
  MAX_ID_COMPONENT_LENGTH,
  safeIdComponent,
} from "./extension-id"

describe("safeIdComponent", () => {
  it("leaves the shapes real publishers and names use untouched", () => {
    for (const value of ["ms-python", "python", "rust-lang", "rust_analyzer", "a", "vscode9"]) {
      expect(safeIdComponent("name", value)).toBe(value)
    }
  })

  it("escapes dots — the one change from the old rule", () => {
    // These are the exact inputs that used to pass through and compose into
    // a traversing id.
    expect(safeIdComponent("name", ".")).toBe("-")
    expect(safeIdComponent("name", "..")).toBe("--")
    expect(safeIdComponent("name", "a.b")).toBe("a-b")
  })

  it("keeps escaping everything else it always did", () => {
    // Pre-existing contract, preserved: unusual characters are normalised
    // rather than rejected.
    expect(safeIdComponent("publisher", "publisher@with@symbols")).toBe("publisher-with-symbols")
    expect(safeIdComponent("name", "weird name with spaces")).toBe("weird-name-with-spaces")
  })

  it("escapes path separators", () => {
    expect(safeIdComponent("name", "../etc/passwd")).toBe("---etc-passwd")
    expect(safeIdComponent("name", "a\\b")).toBe("a-b")
  })

  it("rejects an empty component instead of escaping it to nothing", () => {
    // Escaping `""` is a no-op, and `""` + `""` composes into `"."` — so this
    // one has to be an error, not a rewrite.
    expect(() => safeIdComponent("publisher", "")).toThrow(InvalidExtensionIdError)
  })

  it("rejects non-string manifest values", () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(() => safeIdComponent("name", value)).toThrow(InvalidExtensionIdError)
    }
  })

  it("rejects an overlong component", () => {
    expect(() => safeIdComponent("name", "a".repeat(MAX_ID_COMPONENT_LENGTH + 1))).toThrow(
      InvalidExtensionIdError
    )
    expect(safeIdComponent("name", "a".repeat(MAX_ID_COMPONENT_LENGTH))).toHaveLength(
      MAX_ID_COMPONENT_LENGTH
    )
  })

  it("names the offending component in the error", () => {
    expect(() => safeIdComponent("publisher", "")).toThrow(/publisher/)
    expect(() => safeIdComponent("name", "")).toThrow(/name/)
  })
})

describe("canonicalExtensionId", () => {
  it("composes publisher.name", () => {
    expect(canonicalExtensionId("ms-python", "python")).toBe("ms-python.python")
  })

  it("rejects the manifest that used to compose into the parent directory", () => {
    // publisher "" + name "." => ".." => install_root.join("..") resolved
    // outside the extension root ahead of a recursive delete.
    expect(() => canonicalExtensionId("", ".")).toThrow(InvalidExtensionIdError)
  })

  it("rejects the manifest that used to compose into the current directory", () => {
    // publisher "" + name "" => "." => wiped the whole extension root.
    expect(() => canonicalExtensionId("", "")).toThrow(InvalidExtensionIdError)
  })

  it("can never produce a traversing path component, whatever the manifest says", () => {
    const hostile = ["", ".", "..", "...", "a.b", "../../etc", "/abs", "a/b", "a\\b", ".hidden"]
    for (const publisher of hostile) {
      for (const name of hostile) {
        let id: string
        try {
          id = canonicalExtensionId(publisher, name)
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidExtensionIdError) // rejected — also safe
          continue
        }
        expect(id).not.toBe(".")
        expect(id).not.toBe("..")
        expect(id).not.toContain("/")
        expect(id).not.toContain("\\")
        // Exactly one dot: the separator this function itself inserted.
        expect(id.split(".")).toHaveLength(2)
      }
    }
  })
})
