import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { detectToolchain, toolchainPromptSnippet } from "./detect.mjs"

function mk() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-detect-"))
}

test("detects pnpm + typescript + next + tailwind", () => {
  const d = mk()
  fs.writeFileSync(
    path.join(d, "package.json"),
    JSON.stringify({ dependencies: { next: "16", react: "19", tailwindcss: "4" } })
  )
  fs.writeFileSync(path.join(d, "pnpm-lock.yaml"), "")
  fs.writeFileSync(path.join(d, "tsconfig.json"), "{}")
  const tc = detectToolchain(d)
  assert.equal(tc.packageManager, "pnpm")
  assert.ok(tc.languages.includes("typescript"))
  assert.ok(tc.languages.includes("javascript"))
  assert.ok(tc.frameworks.includes("next"))
  assert.ok(tc.frameworks.includes("tailwind"))
  assert.equal(tc.typescript, true)
})

test("detects rust", () => {
  const d = mk()
  fs.writeFileSync(path.join(d, "Cargo.toml"), "[package]")
  const tc = detectToolchain(d)
  assert.deepEqual(tc.languages, ["rust"])
  assert.equal(tc.packageManager, "cargo")
})

test("detects go", () => {
  const d = mk()
  fs.writeFileSync(path.join(d, "go.mod"), "module x")
  const tc = detectToolchain(d)
  assert.deepEqual(tc.languages, ["go"])
  assert.equal(tc.packageManager, "go")
})

test("detects python via pyproject + uv lock", () => {
  const d = mk()
  fs.writeFileSync(path.join(d, "pyproject.toml"), "")
  fs.writeFileSync(path.join(d, "uv.lock"), "")
  const tc = detectToolchain(d)
  assert.deepEqual(tc.languages, ["python"])
  assert.equal(tc.packageManager, "uv")
})

test("empty dir → no detection, null snippet", () => {
  const d = mk()
  const tc = detectToolchain(d)
  assert.deepEqual(tc.languages, [])
  assert.equal(tc.packageManager, null)
  assert.equal(toolchainPromptSnippet(tc), null)
})

test("toolchainPromptSnippet summarizes", () => {
  const snippet = toolchainPromptSnippet({
    languages: ["typescript"],
    packageManager: "pnpm",
    frameworks: ["next"],
    typescript: true,
  })
  assert.equal(snippet, "Detected project toolchain: pnpm · typescript · next.")
})
