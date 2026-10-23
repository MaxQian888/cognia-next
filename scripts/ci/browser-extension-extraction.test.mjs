import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
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

test("external consumer checks remain package scripts rather than unlisted Host binaries", async () => {
  const workflow = parse(await read(".github/workflows/test.yml"))
  const step = workflow.jobs["e2e-browser-extension"].steps.find(
    (step) => step.name === "Check standalone extension"
  )
  const root = await mkdtemp(join(tmpdir(), "cognia-consumer-knip-"))
  try {
    await mkdir(join(root, ".github/workflows"), { recursive: true })
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "host-fixture",
        private: true,
        scripts: { "format:check": "node --version" },
      })
    )
    await writeFile(join(root, "index.ts"), "export {}")
    await writeFile(
      join(root, "knip.json"),
      JSON.stringify({ entry: ["index.ts"], project: ["index.ts"] })
    )
    await writeFile(
      join(root, ".github/workflows/test.yml"),
      JSON.stringify({
        on: "workflow_dispatch",
        jobs: { consumer: { "runs-on": "ubuntu-latest", steps: [step] } },
      })
    )
    const runner = fileURLToPath(new URL("../../node_modules/knip/bin/knip.js", import.meta.url))
    const result = spawnSync(
      process.execPath,
      [runner, "--include", "binaries", "--reporter", "json", "--no-config-hints"],
      { cwd: root, encoding: "utf8", env: { ...process.env, CI: "true" } }
    )
    assert.equal(result.status, 0, result.stderr || result.stdout)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
