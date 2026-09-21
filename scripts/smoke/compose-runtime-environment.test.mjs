import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  acpInitializeLine,
  acpResponse,
  CONTAINER_TIER_UID,
  pinnedImage,
  placementProblems,
  runtimeFieldsDigest,
  sealSpec,
  SMOKE_IMAGES,
  smokeBaseline,
  smokeSpec,
} from "./compose-runtime-environment.mjs"

const fixtures = JSON.parse(
  readFileSync(new URL("../../protocol/environment-spec-fixtures.json", import.meta.url), "utf8")
)
const DIGEST = `sha256:${"a".repeat(64)}`
const BUNDLE = `ghcr.io/acme/cognia-agent-bundle@sha256:${"b".repeat(64)}`

// The smoke is only worth running if its specs are the ones the Host would
// accept, so its sealing is replayed against the shared fixtures.
test("seals every shared fixture to the digest the Rust side computes", () => {
  for (const fixture of fixtures.cases) {
    const sealed = sealSpec({ ...fixture.spec, specDigest: "stale" })
    assert.equal(sealed.specDigest, fixture.specDigest, fixture.name)
    assert.deepEqual(Object.keys(sealed).slice(0, 2), ["version", "specDigest"])
  }
})

test("digests runtime fields as approvals freeze them", () => {
  const minimal = fixtures.cases.find((fixture) => fixture.name === "projectSettingMinimal")
  assert.equal(runtimeFieldsDigest(), minimal.runtimeFieldsDigest)
  for (const fixture of fixtures.cases) {
    assert.equal(runtimeFieldsDigest(fixture.spec), fixture.runtimeFieldsDigest, fixture.name)
  }
})

test("builds a baseline that allowlists the smoke images and offers the bundle", () => {
  const baseline = smokeBaseline({ bundleImage: BUNDLE, releaseTag: "v1.2.3" })
  assert.equal(baseline.sandboxPool.enabled, true)
  assert.equal(baseline.multiTenant, false)
  assert.deepEqual(baseline.registryAllowlist, [
    { registry: "docker.io", repositoryPrefix: "library" },
  ])
  for (const image of SMOKE_IMAGES) {
    const { registry, repository } = pinnedImage(`${image.reference}@${DIGEST}`)
    assert.ok(
      baseline.registryAllowlist.some(
        (rule) => rule.registry === registry && repository.startsWith(`${rule.repositoryPrefix}/`)
      ),
      image.reference
    )
  }
  assert.deepEqual(baseline.bundle, {
    current: {
      registry: "ghcr.io",
      repository: "acme/cognia-agent-bundle",
      digest: `sha256:${"b".repeat(64)}`,
      releaseTag: "v1.2.3",
    },
    retained: [],
  })
  assert.equal(baseline.sizeClasses.length, 1)
  assert.equal(baseline.sizeClasses[0].gpu, undefined)
})

test("refuses a bundle that is not pinned to a digest", () => {
  assert.throws(() => smokeBaseline({ bundleImage: "ghcr.io/acme/bundle:latest" }), /not pinned/)
})

test("resolves each smoke image onto one libc tree each", () => {
  assert.deepEqual(SMOKE_IMAGES.map((image) => image.libc).sort(), ["glibc", "musl"])
  assert.deepEqual(SMOKE_IMAGES.map((image) => image.source).sort(), [
    "project-setting",
    "repo-declaration",
  ])
})

function spec() {
  return smokeSpec({
    projectId: "smoke-musl-1",
    source: { kind: "project-setting", catalogEntryId: "smoke-musl-1" },
    image: pinnedImage(`docker.io/library/node@${DIGEST}`),
    catalogEntryId: "smoke-musl-1",
    bundle: { digest: `sha256:${"b".repeat(64)}`, releaseTag: "v1" },
    sizeClassId: "smoke",
  })
}

test("asks for a networkless ephemeral container sandbox on the current bundle", () => {
  const sealed = spec()
  assert.equal(sealed.lifecycle, "ephemeral")
  assert.deepEqual(sealed.egress, { tier: "off", presetIds: [], approvedDomains: [] })
  assert.deepEqual(sealed.isolation, { minimum: "container" })
  assert.equal(sealed.bundle.pinned, false)
  assert.equal(sealed.image.catalogEntryId, "smoke-musl-1")
  assert.equal(sealSpec(sealed).specDigest, sealed.specDigest)
})

function placement(overrides = {}) {
  const sealed = spec()
  return {
    sealed,
    placement: {
      kind: "sandbox",
      driver: "docker",
      specDigest: sealed.specDigest,
      image: `docker.io/library/node@${DIGEST}`,
      sizeClassId: "smoke",
      isolationTier: "container",
      bundle: { digest: sealed.bundle.digest, releaseTag: "v1", libc: "musl" },
      command: "codex-acp",
      user: { name: null, uid: CONTAINER_TIER_UID, gid: CONTAINER_TIER_UID, remappedFrom: null },
      egress: { tier: "off", enforced: true },
      credentials: { mode: "none" },
      ...overrides,
    },
  }
}

test("accepts the placement of the sandbox it asked for", () => {
  const { sealed, placement: reported } = placement()
  assert.deepEqual(
    placementProblems(reported, { spec: sealed, libc: "musl", availableTiers: ["container"] }),
    []
  )
})

test("expects root on a stronger tier the Host attested", () => {
  const { sealed, placement: reported } = placement({
    isolationTier: "gvisor",
    user: { name: "root", uid: 0, gid: 0 },
  })
  const context = { spec: sealed, libc: "musl", availableTiers: ["container", "gvisor"] }
  assert.deepEqual(placementProblems(reported, context), [])
  assert.match(
    placementProblems({ ...reported, user: { uid: CONTAINER_TIER_UID } }, context).join(),
    /uid 10001, want 0/
  )
})

test("names every way a placement can differ from the request", () => {
  const { sealed, placement: reported } = placement({
    driver: "kube",
    specDigest: "0".repeat(64),
    image: "docker.io/library/node@sha256:other",
    isolationTier: "vm",
    bundle: { digest: "sha256:other", libc: "glibc" },
    command: "claude-agent-acp",
    user: { uid: 0 },
    egress: { tier: "allowlist", enforced: false },
    credentials: { mode: "gateway" },
  })
  const problems = placementProblems(reported, {
    spec: sealed,
    libc: "musl",
    availableTiers: ["container"],
  })
  // Nine, not ten: on the `vm` tier root is the expected user.
  assert.equal(problems.length, 9, problems.join("\n"))
  assert.ok(!problems.some((problem) => problem.startsWith("runs as")))
})

test("treats a fallback as the wrong answer outright", () => {
  const { sealed } = placement()
  const problems = placementProblems(
    { kind: "fallback", code: "sandbox_fallback_driver_unavailable" },
    { spec: sealed, libc: "musl", availableTiers: ["container"] }
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /expected a sandbox placement/)
})

test("speaks one ACP initialize line and finds its answer", () => {
  const line = acpInitializeLine(7)
  assert.ok(!line.includes("\n"))
  assert.deepEqual(JSON.parse(line), {
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    },
  })
  const answer = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { protocolVersion: 1 } })
  assert.equal(acpResponse(answer, 7)?.result.protocolVersion, 1)
  assert.equal(acpResponse(answer, 8), undefined)
  assert.equal(acpResponse('{"jsonrpc":"2.0","method":"session/update"}', 7), undefined)
  assert.equal(acpResponse("not json", 7), undefined)
  assert.equal(acpResponse(undefined, 7), undefined)
})
