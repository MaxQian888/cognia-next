import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8")

test("the extracted extension is not a product workspace, version target or local runner", async () => {
  const pkg = JSON.parse(await read("package.json"))
  assert.equal(pkg.scripts["browser-ext:build"], undefined)
  assert.equal(pkg.scripts["browser-ext:typecheck"], undefined)
  assert.equal(pkg.scripts["test:e2e:browser-ext"], undefined)
  assert.doesNotMatch(await read("pnpm-workspace.yaml"), /^\s*- browser-extension\s*$/m)
  assert.doesNotMatch(await read("pnpm-lock.yaml"), /^  browser-extension:/m)
  assert.doesNotMatch(
    await read("scripts/sync/version-sync.mjs"),
    /browser-extension\/package\.json/
  )
  assert.doesNotMatch(await read("jest.config.ts"), /"\^@ext\//)
  assert.doesNotMatch(await read("playwright.config.ts"), /name: "browser-extension"/)
  assert.doesNotMatch(await read("knip.jsonc"), /"browser-extension"\s*:/)
  assert.doesNotMatch(await read("eslint.config.mjs"), /"browser-extension\//)
  for (const dockerfile of [
    "deploy/compose/Dockerfile.web",
    "deploy/docker/Dockerfile.cognia-server",
  ]) {
    assert.doesNotMatch(await read(dockerfile), /^COPY browser-extension\b/m)
  }
})

test("Host changes validate an immutable standalone extension revision", async () => {
  const pin = JSON.parse(await read("integrations/browser-companion.json"))
  assert.equal(pin.repository, "cognia-labs/cognia-browser-extension")
  assert.match(pin.revision, /^[a-f0-9]{40}$/)
  const workflow = await read(".github/workflows/test.yml")
  assert.match(workflow, /repository: cognia-labs\/cognia-browser-extension/)
  assert.match(workflow, /check-browser-companion-contract\.mjs/)
  assert.match(workflow, /working-directory: \.cache\/browser-companion/)
  const guide = await read("docs/development/browser-extension-extraction.md")
  assert.match(guide, /cognia-labs\/cognia-browser-extension/)
  assert.match(guide, /agent-safe-v1/)
})
