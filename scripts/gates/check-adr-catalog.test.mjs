import test from "node:test"
import assert from "node:assert/strict"

import { auditAdrCatalog, explicitStatus } from "./check-adr-catalog.mjs"

test("explicitStatus requires a populated Status section", () => {
  assert.equal(
    explicitStatus("# ADR\n\n## Status\n\nAccepted (2026-08-13)\n"),
    "Accepted (2026-08-13)"
  )
  assert.equal(explicitStatus("| Status | Accepted |\n| --- | --- |"), "Accepted")
  assert.equal(explicitStatus("**状态：** 已接受"), "已接受")
  assert.equal(explicitStatus("# ADR\n\n## Status\n\n## Context\n"), null)
})

test("catalog audit accepts aligned locales and the historical duplicate allowlist", () => {
  const files = ["0013-command-manifest.md", "0013-wasm-plugins.md"]
  const sources = Object.fromEntries(
    files.map((file) => [file, "# ADR\n\n## Status\n\nAccepted\n"])
  )
  assert.deepEqual(
    auditAdrCatalog({
      filesByLocale: { en: files, zh: files },
      pagesByLocale: {
        en: ["index", "0013-command-manifest", "0013-wasm-plugins"],
        zh: ["index", "0013-command-manifest", "0013-wasm-plugins"],
      },
      sourcesByLocale: { en: sources, zh: sources },
    }),
    []
  )
})

test("catalog audit reports locale, sidebar, status, slug, and duplicate drift", () => {
  const problems = auditAdrCatalog({
    filesByLocale: { en: ["0120-first.md", "0120-second.md"], zh: ["bad.md"] },
    pagesByLocale: { en: ["index", "0120-first", "missing"], zh: ["index"] },
    sourcesByLocale: {
      en: { "0120-first.md": "# First", "0120-second.md": "## Status\n\nAccepted" },
      zh: { "bad.md": "## Status\n\nAccepted" },
    },
  })
  assert.ok(problems.some((problem) => problem.includes("no explicit ## Status")))
  assert.ok(problems.some((problem) => problem.includes("missing from adr/meta.json")))
  assert.ok(problems.some((problem) => problem.includes("references missing")))
  assert.ok(problems.some((problem) => problem.includes("not allowlisted")))
  assert.ok(problems.some((problem) => problem.includes("invalid ADR slug")))
  assert.ok(problems.some((problem) => problem.includes("missing locale peer")))
})
