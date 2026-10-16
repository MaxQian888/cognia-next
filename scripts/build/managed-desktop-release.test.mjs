import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  createManagedDesktopRelease,
  parseArgs,
  verifyImageSources,
  writeRelease,
} from "./managed-desktop-release.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const IMAGE_CONTEXT = "crates/cognia-automation/src/cua_sandbox/image"
const digest = `sha256:${"a".repeat(64)}`
const imageRepository = "ghcr.io/cognia-test/cognia-managed-desktop"

test("release uses the published immutable digest and contains no runtime token", () => {
  const release = createManagedDesktopRelease({ imageRepository, digest })
  assert.equal(release.image, `${imageRepository}@${digest}`)
  assert.equal(release.imageDigest, digest)
  assert.equal(release.architecture, "linux/amd64")
  assert.equal(release.recipeRevision, "3")
  assert.equal(release.protocol, "computer-server-0.3.46")
  assert.equal(release.serverVersion, "0.3.46")
  assert.equal(release.startCommand, "sleep infinity")
  assert.match(release.readyCommand, /test -x \/usr\/local\/bin\/cognia-desktop/)
  assert.equal(Object.keys(release).length, 8, "Host release loader rejects unknown fields")
  assert.doesNotMatch(JSON.stringify(release), /TOKEN|secret|latest/)
})

test("unpublished tags, malformed digests and repository substitutions refuse", () => {
  for (const invalid of [
    undefined,
    "",
    "latest",
    "sha256:abc",
    `sha256:${"A".repeat(64)}`,
    `${digest}\n`,
  ]) {
    assert.throws(() => createManagedDesktopRelease({ imageRepository, digest: invalid }))
  }
  for (const invalid of [
    undefined,
    "ghcr.io/Owner/cognia-managed-desktop",
    `${imageRepository}:latest`,
    `${imageRepository}@${digest}`,
    "https://ghcr.io/owner/cognia-managed-desktop",
    "ghcr.io/owner/other-image",
    "ghcr.io/a/../cognia-managed-desktop",
  ]) {
    assert.throws(() => createManagedDesktopRelease({ imageRepository: invalid, digest }))
  }
})

test("the actual pinned image and guest health agree with the release manifest", () => {
  verifyImageSources(ROOT)
})

test("recipe drift and mutable base prevent publication of a stale manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-recipe-"))
  const context = resolve(root, IMAGE_CONTEXT)
  mkdirSync(context, { recursive: true })
  const dockerfile = readFileSync(resolve(ROOT, IMAGE_CONTEXT, "Dockerfile"), "utf8")
  const server = readFileSync(resolve(ROOT, IMAGE_CONTEXT, "server.py"), "utf8")
  try {
    writeFileSync(join(context, "server.py"), server)
    writeFileSync(
      join(context, "Dockerfile"),
      dockerfile.replace('cognia.cua.recipe="3"', 'cognia.cua.recipe="4"')
    )
    assert.throws(() => verifyImageSources(root), /identity/)
    writeFileSync(join(context, "Dockerfile"), dockerfile.replace(/@sha256:[0-9a-f]{64}/, ""))
    assert.throws(() => verifyImageSources(root), /digest pinned/)
    writeFileSync(join(context, "Dockerfile"), dockerfile)
    writeFileSync(
      join(context, "server.py"),
      server.replace('"recipeRevision": "3"', '"recipeRevision": "4"')
    )
    assert.throws(() => verifyImageSources(root), /health identity/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("CLI rejects missing, duplicate and unknown arguments before writing", () => {
  for (const args of [
    [],
    ["--image", imageRepository],
    ["--image", imageRepository, "--image", imageRepository],
    ["--image", "--digest"],
    ["--unknown", "x"],
  ]) {
    assert.throws(() => parseArgs(args))
  }
})

test("CLI writes the complete manifest and a rejected replacement keeps it intact", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-release-"))
  try {
    const output = join(root, "managed-desktop-release.json")
    const args = ["--image", imageRepository, "--digest", digest, "--output", output]
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/build/managed-desktop-release.mjs"), ...args],
      { encoding: "utf8" }
    )
    assert.equal(result.status, 0, result.stderr)
    const bytes = readFileSync(output, "utf8")
    assert.deepEqual(JSON.parse(bytes), createManagedDesktopRelease({ imageRepository, digest }))
    assert.throws(() =>
      writeRelease(["--image", imageRepository, "--digest", "latest", "--output", output])
    )
    assert.equal(readFileSync(output, "utf8"), bytes)
    assert.deepEqual(readdirSync(root), ["managed-desktop-release.json"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing Images publication gate owns the release artifact and amd64 build", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/images.yml"), "utf8")
  const job = workflow.split("  managed-desktop-image:\n")[1]?.split("\n  # ADR-0183:")[0]
  assert.ok(job, "managed desktop must be wired into Images")
  assert.match(job, /platforms: linux\/amd64/)
  assert.match(job, /context: crates\/cognia-automation\/src\/cua_sandbox\/image/)
  assert.match(job, /push: \$\{\{ needs.vars.outputs.should_push == 'true' \}\}/)
  assert.match(job, /DIGEST: \$\{\{ steps.build.outputs.digest \}\}/)
  assert.match(job, /name: managed-desktop-release\n/)
  assert.match(job, /if-no-files-found: error/)
  assert.equal(
    (job.match(/if: needs.vars.outputs.should_push == 'true'/g) ?? []).length,
    3,
    "login, manifest and artifact require the existing publish gate"
  )
})
