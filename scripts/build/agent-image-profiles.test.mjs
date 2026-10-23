import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const workflow = readFileSync(
  new URL("../../.github/workflows/images.yml", import.meta.url),
  "utf8"
)

// Keep this release-contract check dependency-free so Images can run it
// before installing the repository's JavaScript workspace dependencies.
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `missing image job ${name}`)
  const rest = workflow.slice(start + 1)
  return rest.slice(0, rest.slice(1).search(/\n  [a-z][a-z-]+:\n/) + 1 || undefined)
}

test("Runner profiles build from the root and promote only smoke-tested digests", () => {
  assert.doesNotMatch(job("fast-images"), /name: cognia-runner/)
  const runner = job("runner-image")
  assert.match(runner, /variant: \[full, codex\]/)
  assert.match(runner, /node --test[^\n]*deploy\/runner\/install-selected\.test\.mjs/)
  assert.match(runner, /context: \.\n/)
  assert.match(runner, /target: .*'selected'.*'full'/)
  assert.match(runner, /build-args: AGENT_RUNTIMES=codex-acp,codex-app-server/)
  assert.match(runner, /outputs: .*push-by-digest=true/)
  const smokeIndex = runner.indexOf("node deploy/runner/smoke.mjs")
  const promoteIndex = runner.indexOf("docker buildx imagetools create")
  assert.ok(smokeIndex > runner.indexOf("id: build"))
  assert.ok(promoteIndex > smokeIndex)
  assert.match(runner.slice(smokeIndex), /\^sha256:/)
  assert.match(runner, /flavor: .*codex/)
  assert.match(runner, /value=latest,/)
  assert.match(runner, /value=latest-full,/)
})

test("Bundle profiles smoke each native architecture and keep tested digests separate", () => {
  const bundle = job("agent-bundle")
  assert.match(bundle, /variant: \[full, codex\]/)
  assert.match(bundle, /arch: \[amd64, arm64\]/)
  assert.match(bundle, /arch: amd64\s+platform: linux\/amd64\s+runner: ubuntu-latest/)
  assert.match(bundle, /arch: arm64\s+platform: linux\/arm64\s+runner: ubuntu-24.04-arm/)
  assert.match(bundle, /AGENT_RUNTIMES=.*matrix.variant.*codex-acp,codex-app-server/)
  assert.match(bundle, /outputs: .*push-by-digest=true/)
  const smokeIndex = bundle.indexOf("sh deploy/bundle/smoke.sh")
  const recordIndex = bundle.indexOf("name: Record tested platform digest")
  assert.ok(smokeIndex > bundle.indexOf("id: build"))
  assert.ok(recordIndex > smokeIndex)
  assert.match(bundle, /name: agent-bundle-digest-.*matrix.variant.*matrix.arch/)
  assert.match(bundle, /path: .*agent-bundle-digests\/.*matrix.variant.*matrix.arch/)
  const publish = job("agent-bundle-manifest")
  assert.match(publish, /needs: \[vars, agent-bundle\]/)
  assert.match(publish, /variant: \[full, codex\]/)
  assert.match(publish, /flavor: .*codex/)
  assert.match(publish, /pattern: agent-bundle-digest-.*matrix.variant/)
  assert.match(publish, /\$DIGEST_DIR\/\$VARIANT-\$arch.txt/)
})

test("Image profile and smoke inputs trigger pull request image validation", () => {
  for (const path of [
    "scripts/build/agent-image-profiles.test.mjs",
    "scripts/build/bundle-agent-versions*.mjs",
  ]) {
    assert.ok(workflow.includes(`- "${path}"`), path)
  }
})

test("selected Runner binds native npm from its final custom base before publishing wrapper PATH", () => {
  const dockerfile = readFileSync(
    new URL("../../deploy/runner/Dockerfile", import.meta.url),
    "utf8"
  )
  const selected = dockerfile.slice(
    dockerfile.indexOf("FROM base AS selected"),
    dockerfile.indexOf("FROM base AS full")
  )
  assert.match(selected, /COGNIA_NATIVE_NPX="\$\(command -v npx \|\| true\)"/)
  assert.match(selected, /\/cognia\/glibc\/node\/bin\/node .* configure-base/)
  assert.ok(selected.indexOf("configure-base") < selected.indexOf("ENV PATH="))
  const builder = dockerfile.slice(
    dockerfile.indexOf("AS selected-build"),
    dockerfile.indexOf("FROM ${RUNTIME_IMAGE}")
  )
  assert.ok(builder.indexOf("COPY deploy/runner/install-selected.mjs") > builder.indexOf("npm ci"))
})
