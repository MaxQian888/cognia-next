import { inferResourceKind, isCanonicalBundleDir } from "./classify"

describe("inferResourceKind", () => {
  it("honours the canonical subdirs over the file extension", () => {
    // A markdown file under scripts/ is still a script; a .sh under
    // references/ is still a reference — the dir name is the authoring signal.
    expect(inferResourceKind("scripts/check.sh")).toBe("script")
    expect(inferResourceKind("scripts/notes.md")).toBe("script")
    expect(inferResourceKind("references/notes.md")).toBe("reference")
    expect(inferResourceKind("references/run.sh")).toBe("reference")
    expect(inferResourceKind("assets/icon.png")).toBe("asset")
  })

  it("classifies Claude Code `resources/` files per-extension", () => {
    expect(inferResourceKind("resources/guide.md")).toBe("reference")
    expect(inferResourceKind("resources/helper.py")).toBe("script")
    expect(inferResourceKind("resources/logo.png")).toBe("asset")
  })

  it("classifies ad-hoc dirs and root stragglers per-extension", () => {
    expect(inferResourceKind("examples/demo.py")).toBe("script")
    expect(inferResourceKind("docs/spec.md")).toBe("reference")
    expect(inferResourceKind("README.md")).toBe("reference")
    expect(inferResourceKind("run.sh")).toBe("script")
    expect(inferResourceKind("data.bin")).toBe("asset")
  })

  it("is case-insensitive on the dir name and the extension", () => {
    expect(inferResourceKind("Scripts/check.SH")).toBe("script")
    expect(inferResourceKind("References/Notes.MD")).toBe("reference")
  })

  it("falls back to asset for unknown extensions", () => {
    expect(inferResourceKind("resources/mystery.qux")).toBe("asset")
    expect(inferResourceKind("noext")).toBe("asset")
  })
})

describe("isCanonicalBundleDir", () => {
  it("recognises the canonical subdirs case-insensitively", () => {
    expect(isCanonicalBundleDir("scripts")).toBe(true)
    expect(isCanonicalBundleDir("References")).toBe(true)
    expect(isCanonicalBundleDir("ASSETS")).toBe(true)
  })

  it("rejects non-canonical dir names", () => {
    expect(isCanonicalBundleDir("resources")).toBe(false)
    expect(isCanonicalBundleDir("examples")).toBe(false)
    expect(isCanonicalBundleDir("")).toBe(false)
  })
})
