import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const readWorkflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")

test("CI workflows provision their clean-checkout prerequisites", async () => {
  const [quality, report, testWorkflow] = await Promise.all([
    readWorkflow("quality.yml"),
    readWorkflow("report.yml"),
    readWorkflow("test.yml"),
  ])

  assert.match(quality, /sudo apt-get install -y[\s\S]*ripgrep/)
  assert.match(quality, /matrix\.group == 'artifacts'[\s\S]*pnpm plugin-node:prepare/)
  assert.match(report, /pnpm\/action-setup@[\w.-]+[\s\S]*pnpm install --frozen-lockfile/)
  assert.match(testWorkflow, /NODE_OPTIONS: "--max-old-space-size=16384"/)
  assert.match(testWorkflow, /--maxWorkers=4/)
  assert.match(testWorkflow, /sidecars:build[\s\S]*sidecars:test/)
  assert.match(testWorkflow, /libpipewire-0\.3-dev/)
})

test("CI exposes stable and complete verification seams", async () => {
  const [ci, nightly, testWorkflow] = await Promise.all([
    readWorkflow("ci.yml"),
    readWorkflow("nightly.yml"),
    readWorkflow("test.yml"),
  ])

  assert.match(
    ci,
    /ci-gate:[\s\S]*name: CI Gate[\s\S]*needs:\s*\[quality, test\][\s\S]*if: always\(\)/
  )
  assert.match(testWorkflow, /conformance:[\s\S]*pnpm test:conformance/)
  assert.match(testWorkflow, /docs-build:[\s\S]*pnpm docs:build/)
  assert.match(testWorkflow, /web-build:[\s\S]*pnpm web:build/)
  assert.match(testWorkflow, /mobile-android-build:[\s\S]*assembleDebug/)
  assert.doesNotMatch(nightly, /build-tauri:[\s\S]*needs: test/)
})

test("formatting and lint exclude generated test and extension artifacts", async () => {
  const [prettierIgnore, eslintConfig] = await Promise.all([
    readFile(new URL("../../.prettierignore", import.meta.url), "utf8"),
    readFile(new URL("../../eslint.config.mjs", import.meta.url), "utf8"),
  ])
  assert.match(prettierIgnore, /^browser-extension\/\.wxt\/$/m)
  assert.match(eslintConfig, /"public\/_cognia\/\*\*"/)
  assert.match(eslintConfig, /"playwright-report\/\*\*"/)
  assert.match(eslintConfig, /"test-results\/\*\*"/)
})

test("dependency audit waives only unpublished image-size fixes", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")
  )
  assert.match(packageJson.scripts["audit:deps"], /GHSA-w3rx-r6r6-pgpr/)
  assert.match(packageJson.scripts["audit:deps"], /GHSA-5p2g-fcmc-qvqq/)
  assert.doesNotMatch(packageJson.scripts["audit:deps"], /ignore-unfixable/)
})

// The supply-chain gate is blocking, and CI_CD.md requires every waiver to name
// its advisory AND say why no safe upgrade exists. `package.json` cannot carry
// a comment, so the reason lives beside the same ids in `pnpm-workspace.yaml`.
// Without this check a waiver could quietly outlive its justification.
test("every waived advisory is justified where the reason can be written down", async () => {
  const [packageJson, workspaceYaml] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
  ])
  const waived = [...packageJson.scripts["audit:deps"].matchAll(/--ignore (GHSA-[\w-]+)/g)].map(
    (match) => match[1]
  )
  assert.ok(waived.length > 0, "the flags this file pins above must be parseable")

  const auditConfig = workspaceYaml.slice(workspaceYaml.indexOf("auditConfig:"))
  assert.ok(auditConfig.includes("ignoreGhsas:"), "waivers must be mirrored in pnpm-workspace.yaml")
  const lines = auditConfig.split("\n")
  for (const advisory of waived) {
    const index = lines.findIndex((line) => line.trim() === `- ${advisory}`)
    assert.ok(index > 0, `${advisory} is missing from pnpm-workspace.yaml auditConfig.ignoreGhsas`)
    // Walk back over any sibling ids to the comment block that covers them.
    let cursor = index - 1
    while (cursor >= 0 && lines[cursor].trim().startsWith("- GHSA-")) cursor -= 1
    assert.match(
      lines[cursor]?.trim() ?? "",
      /^#/,
      `${advisory} has no written justification in pnpm-workspace.yaml`
    )
  }
  assert.match(auditConfig, /reviewAfter:/, "waivers must carry a review date")
})
