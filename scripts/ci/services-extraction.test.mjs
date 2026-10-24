import assert from "node:assert/strict"
import { access, readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { parse } from "yaml"

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8")
const absent = (path) =>
  assert.rejects(access(new URL(`../../${path}`, import.meta.url)), { code: "ENOENT" }, path)

const MOVED_SERVICES = [
  "diagnostic-server",
  "identity-server",
  "logto-email",
  "share-server",
  "signaling-server",
  "status-server",
  "sync-server",
  "update-server",
]

test("the extracted services are not product sources, workspaces or local runners", async () => {
  for (const service of MOVED_SERVICES) await absent(`services/${service}`)
  await absent("packages/sync-protocol")
  for (const workflow of [
    "signaling-server.yml",
    "share-server.yml",
    "sync-server.yml",
    "identity-server.yml",
  ])
    await absent(`.github/workflows/${workflow}`)
  const remaining = await readdir(new URL("../../services", import.meta.url))
  assert.deepEqual(
    remaining.filter((entry) => !entry.startsWith(".")),
    ["workspace-runtime"]
  )

  const pkg = JSON.parse(await read("package.json"))
  for (const script of Object.keys(pkg.scripts))
    assert.doesNotMatch(script, /^(update:worker|webrtc:smoke)/, script)
  for (const command of Object.values(pkg.scripts))
    assert.doesNotMatch(command, /services\/(?!workspace-runtime)[a-z-]+/, command)
  for (const file of ["Cargo.toml", "tsconfig.json", "jest.config.ts", "eslint.config.mjs"])
    assert.doesNotMatch(await read(file), /services\/(?!workspace-runtime)[a-z-]+-server/, file)
  for (const dockerfile of ["deploy/bundle/Dockerfile", "deploy/docker/Dockerfile.cognia-server"])
    assert.doesNotMatch(await read(dockerfile), /^COPY services\/signaling-server/m, dockerfile)
})

test("shared contracts resolve from the services repository at the pin", async () => {
  const pin = JSON.parse(await read("integrations/cognia-services.json"))
  assert.equal(pin.repository, "cognia-labs/cognia-services")
  const pkg = JSON.parse(await read("package.json"))
  for (const name of ["@cognia/status-contract", "@cognia/sync-protocol"])
    assert.match(pkg.dependencies[name], new RegExp(`cognia-services\\.git#${pin.revision}&path:`))
  assert.match(
    await read("Cargo.toml"),
    new RegExp(`cognia-signaling-core = \\{[^}]*${pin.revision}`)
  )
  for (const shim of ["contract", "config", "derive", "signing", "validate", "fixtures"])
    assert.match(
      await read(`lib/status/${shim}.ts`),
      new RegExp(`^export \\* from "@cognia/status-contract/${shim}"$`, "m")
    )
  const guide = await read("docs/development/services-extraction.md")
  assert.match(guide, /cognia-labs\/cognia-services/)
  assert.match(guide, /COGNIA_SERVICES_ROOT/)
})

test("the pinned lane runs even when unrelated test planning fails", async () => {
  const workflow = parse(await read(".github/workflows/test.yml"))
  const lane = workflow.jobs["cognia-services"]
  assert.match(lane.if, /!cancelled\(\)/)
  assert.match(lane.if, /needs\.jest-plan\.result != 'success' \|\|/)
  assert.match(lane.if, /fromJSON\(needs\.jest-plan\.outputs\.impacts\)\.cogniaServices/)
  const runs = lane.steps.map((step) => step.run ?? "").join("\n")
  assert.match(runs, /check-cognia-services\.mjs --services-root \.cache\/cognia-services/)
  const sourceReaders = lane.steps.filter((step) => step.env?.COGNIA_SERVICES_ROOT)
  assert.ok(sourceReaders.length >= 3, "the suites that read service sources get the checkout")
  assert.ok(lane.steps.some((step) => step.uses === "./.github/actions/checkout-cognia-services"))
})
