import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parse } from "yaml"

const readWorkflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")

test("frontend build caches cover each build mode without sharing incompatible compilation state", async () => {
  const scopes = new Set()
  for (const [workflow, jobName, cachePath] of [
    ["test.yml", "build", ".next/cache"],
    ["test.yml", "build-e2e", ".next/cache"],
    ["test.yml", "docs-build", "docs/.next/cache"],
    ["test.yml", "web-build", "web/.next/cache"],
    ["test.yml", "mobile-android-build", ".next/cache"],
    ["test.yml", "mobile-ios-build", ".next/cache"],
    ["test.yml", "e2e-tauri", ".next/cache"],
    ["build-tauri.yml", "build-tauri", ".next/cache"],
    ["deploy.yml", "deploy-docs", "docs/.next/cache"],
    ["deploy.yml", "deploy-web", "web/.next/cache"],
  ]) {
    const { jobs } = parse(await readWorkflow(workflow))
    const job = jobs[jobName]
    assert.ok(job, `${workflow}: ${jobName}`)
    const cache = job.steps.find(
      (step) => step.uses?.startsWith("actions/cache@") && step.with.path.trim() === cachePath
    )
    assert.ok(cache, `${workflow}: ${jobName} persists its compiler cache`)
    assert.match(cache.with.key, /runner\.os/)
    assert.match(cache.with.key, /runner\.arch/)
    assert.match(cache.with.key, /node26/)
    assert.match(cache.with.key, /pnpm-lock\.yaml/)
    assert.match(cache.with.key, /next\.config/)
    assert.match(cache.with.key, /github\.sha/)
    const scope = cache.with["restore-keys"].trim()
    assert.ok(!scopes.has(scope), `${workflow}: ${jobName} has a distinct mode/origin scope`)
    scopes.add(scope)
    assert.equal(scope, cache.with.key.replace(/\$\{\{ github\.sha \}\}$/, ""))
    if (workflow === "deploy.yml") {
      assert.match(scope, /inputs\.environment/)
      assert.match(scope, /vars\.DOCS_SITE_URL/)
      if (jobName === "deploy-web") assert.match(scope, /vars\.WEB_SITE_URL/)
    }
  }
})

test("Linux frontend consumers reuse this run's compiled packages before frozen install", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  for (const name of [
    "docs-build",
    "web-build",
    "mobile-android-build",
    "sidecar",
    "build",
    "build-e2e",
    "e2e-browser-extension",
  ]) {
    const job = jobs[name]
    const download = job.steps.find(
      (step) => step.name === "Restore compiled workspace prerequisites"
    )
    assert.equal(download.with.name, "jest-runtime-prerequisites", name)
    assert.equal(download.if, "needs.jest-plan.outputs.has-tests == 'true'", name)
    assert.equal(download.with.path, ".", name)
    assert.equal(job.needs, "jest-plan", name)
    const install = job.steps.findIndex(
      (step) => step.run === "pnpm install --frozen-lockfile --prefer-offline"
    )
    assert.ok(job.steps.indexOf(download) < install, name)
  }
})

test("workspace pnpm caches account for the sidecar lock installed by root postinstall", async () => {
  for (const name of [
    "test.yml",
    "quality.yml",
    "build-tauri.yml",
    "release.yml",
    "deploy.yml",
    "compose-e2e.yml",
    "report.yml",
  ]) {
    const { jobs } = parse(await readWorkflow(name))
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/setup-node@") || step.with?.cache !== "pnpm") continue
        const locks = step.with["cache-dependency-path"]
        assert.ok(
          locks?.includes("sidecar/pnpm-lock.yaml") || locks === "**/pnpm-lock.yaml",
          `${name}:${jobName} caches both independently locked stores`
        )
      }
    }
  }
})

test("DeepSeek node:test suites run in their isolated native Node job, never under Jest", async () => {
  const config = await readFile(new URL("../../jest.config.ts", import.meta.url), "utf8")
  assert.ok(config.includes('"/runtime/deepseek-harness/.*\\\\.test\\\\.mjs$"'))
  const { jobs } = parse(await readWorkflow("test.yml"))
  const job = jobs["deepseek-runtime"]
  assert.equal(job.needs, "jest-plan")
  assert.equal(job.if, "fromJSON(needs.jest-plan.outputs.impacts).deepseekRuntime")
  const install = job.steps.find((step) => step.name === "Install isolated runtime")
  assert.match(install.run, /cp runtime\/deepseek-harness\/\* "\$DSH_TEST_ROOT\/"/)
  assert.match(install.run, /npm install --prefix "\$DSH_TEST_ROOT" --ignore-scripts/)
  const test = job.steps.find((step) => step.name === "Run launcher and service smoke suites")
  assert.ok(job.steps.indexOf(install) < job.steps.indexOf(test))
  assert.equal(test["working-directory"], "${{ env.DSH_TEST_ROOT }}")
  assert.match(
    test.run,
    /node --test launcher.test.mjs launcher.smoke.test.mjs services.smoke.test.mjs/
  )
  assert.ok(!job.steps.some((step) => step.run?.includes("pnpm install")))
})

test("server PR image checks can read the registry cache without gaining write permissions", async () => {
  const { jobs } = parse(await readWorkflow("images.yml"))
  const job = jobs["cognia-server-check"]
  assert.deepEqual(job.permissions, { contents: "read", packages: "read" })
  const login = job.steps.find((step) => step.uses?.startsWith("docker/login-action@"))
  assert.equal(login.if, "github.event.pull_request.head.repo.full_name == github.repository")
  assert.equal(login.with.password, "${{ secrets.GITHUB_TOKEN }}")
  const build = job.steps.find((step) => step.uses?.startsWith("docker/build-push-action@"))
  assert.ok(job.steps.indexOf(login) < job.steps.indexOf(build))
  assert.equal(build.with.push, false)
  assert.match(build.with["cache-from"], /^type=registry,/)
  assert.equal(build.with["cache-to"], undefined, "PRs never write the release registry cache")
})

test("agent bundles build once on each native architecture and smoke that exact image", async () => {
  const job = parse(await readWorkflow("images.yml")).jobs["agent-bundle"]
  assert.deepEqual(job.strategy.matrix.include, [
    { arch: "amd64", platform: "linux/amd64", runner: "ubuntu-latest" },
    { arch: "arm64", platform: "linux/arm64", runner: "ubuntu-24.04-arm" },
  ])
  assert.equal(job["runs-on"], "${{ matrix.runner }}")
  assert.equal(job.strategy["fail-fast"], false)
  assert.ok(!job.steps.some((step) => step.uses?.startsWith("docker/setup-qemu-action@")))
  const builds = job.steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"))
  assert.equal(builds.length, 1, "the smoke image must not be rebuilt afterward")
  const build = builds[0]
  assert.equal(build.with.platforms, "${{ matrix.platform }}")
  assert.match(build.with.outputs, /should_push == 'true'/)
  assert.match(build.with.outputs, /push-by-digest=true,name-canonical=true,push=true/)
  assert.match(build.with.outputs, /\|\| 'type=docker'/)
  assert.match(build.with.tags, /\|\| 'cognia-agent-bundle:smoke'/)
  assert.match(build.with["cache-from"], /buildcache-\$\{\{ matrix.arch \}\}/)
  assert.match(build.with["cache-to"], /should_push == 'true'/)
  assert.match(build.with["cache-to"], /matrix.arch/)
  const smoke = job.steps.find((step) => step.name === "Smoke against user images")
  assert.equal(smoke.if, undefined, "both architectures run the full smoke on PRs too")
  assert.equal(smoke.env.DIGEST, "${{ steps.build.outputs.digest }}")
  assert.match(smoke.run, /docker pull "\$IMAGE@\$DIGEST"/)
  assert.match(smoke.run, /sh deploy\/bundle\/smoke.sh "\$bundle"/)
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))
  assert.ok(job.steps.indexOf(upload) > job.steps.indexOf(smoke))
  assert.equal(upload.if, "needs.vars.outputs.should_push == 'true'")
  assert.equal(upload.with["if-no-files-found"], "error")
  assert.match(upload.with.name, /matrix.arch/)
})

test("agent bundle tags are promoted only after both native smoke jobs succeed", async () => {
  const { jobs } = parse(await readWorkflow("images.yml"))
  const merge = jobs["agent-bundle-manifest"]
  assert.deepEqual(merge.needs, ["vars", "agent-bundle"])
  assert.equal(merge.if, "needs.vars.outputs.should_push == 'true'")
  assert.ok(!merge.steps.some((step) => step.uses?.startsWith("docker/build-push-action@")))
  const metadata = merge.steps.find((step) => step.uses?.startsWith("docker/metadata-action@"))
  const otherMetadata = jobs["fast-images"].steps.find((step) => step.id === "meta")
  assert.equal(metadata.with.tags, otherMetadata.with.tags, "preserve release and SHA tag policy")
  const download = merge.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))
  assert.equal(download.with.pattern, "agent-bundle-digest-*")
  assert.equal(download.with["merge-multiple"], true)
})

test("agent manifest assembly requires both valid digests and preserves every tag", async () => {
  const job = parse(await readWorkflow("images.yml")).jobs["agent-bundle-manifest"]
  const step = job.steps.find((item) => item.name === "Assemble tested multi-platform manifest")
  const dir = await mkdtemp(join(tmpdir(), "cognia-agent-manifest-"))
  const digestA = `sha256:${"a".repeat(64)}`
  const digestB = `sha256:${"b".repeat(64)}`
  const log = join(dir, "docker.log")
  try {
    await writeFile(join(dir, "amd64.txt"), `${digestA}\n`)
    await writeFile(join(dir, "arm64.txt"), `${digestB}\n`)
    await writeFile(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$DOCKER_LOG"\n', {
      mode: 0o755,
    })
    const run = () =>
      execFileSync("bash", ["-euo", "pipefail", "-c", step.run], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          DOCKER_LOG: log,
          DIGEST_DIR: dir,
          IMAGE: "ghcr.io/example/cognia-agent-bundle",
          TAGS: "ghcr.io/example/cognia-agent-bundle:1.2.3\nghcr.io/example/cognia-agent-bundle:latest",
        },
        stdio: "pipe",
      })
    run()
    const calls = await readFile(log, "utf8")
    assert.match(calls, /buildx\nimagetools\ncreate\n--tag\n.*:1\.2\.3\n--tag\n.*:latest\n/)
    assert.ok(calls.includes(`ghcr.io/example/cognia-agent-bundle@${digestA}`))
    assert.ok(calls.includes(`ghcr.io/example/cognia-agent-bundle@${digestB}`))
    await writeFile(log, "")
    await writeFile(join(dir, "arm64.txt"), "not-a-digest\n")
    assert.throws(run)
    assert.equal(await readFile(log, "utf8"), "", "invalid ARM digest must not promote AMD alone")
    await rm(join(dir, "arm64.txt"))
    assert.throws(run)
    assert.equal(
      await readFile(log, "utf8"),
      "",
      "missing ARM smoke artifact must block publication"
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("all Jest waves execute one immutable plan for the exact checkout", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  assert.equal(jobs.test.needs, "jest-plan")
  assert.ok(jobs["jest-plan"].steps.some((step) => step.uses?.startsWith("actions/cache/restore@")))
  assert.ok(!jobs.test.steps.some((step) => step.uses?.startsWith("actions/cache/restore@")))
  const publish = jobs["jest-plan"].steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@")
  )
  const consume = jobs.test.steps.find((step) => step.name === "Download frozen Jest test plan")
  assert.equal(publish.with.name, consume.with.name)
  assert.equal(publish.with["if-no-files-found"], "error")
  assert.equal(publish.with["include-hidden-files"], true)
  assert.equal(publish.with.path, `${consume.with.path}plan.json`)
  assert.ok(
    jobs.test.steps.indexOf(consume) <
      jobs.test.steps.findIndex((step) => step.name === "Run Jest planned shard")
  )
  const planning = jobs["jest-plan"].steps.find((step) => step.id === "plan")
  assert.equal(planning.env.PR_BASE_SHA, "${{ github.event.pull_request.base.sha }}")
  assert.match(planning.run, /git fetch --no-tags --depth=1 origin "\$base"/)
  assert.match(planning.run, /--head "\$GITHUB_SHA"/)
  assert.match(planning.run, /pull_request.*mode=incremental/)
  assert.equal(jobs.test.strategy.matrix, "${{ fromJSON(needs.jest-plan.outputs.matrix) }}")
  assert.equal(jobs.test.if, "needs.jest-plan.outputs.has-tests == 'true'")
  assert.equal(
    jobs.test.strategy["max-parallel"],
    "${{ needs.jest-plan.outputs.mode == 'incremental' && 4 || 8 }}"
  )
  assert.match(jobs["coverage-merge"].if, /outputs.mode == 'full'/)
  assert.match(jobs["coverage-changed"].if, /outputs.mode == 'full'/)
})

test("bundle gate tests provision the release Bun version and build webclone first", async () => {
  const quality = parse(await readWorkflow("quality.yml"))
  const release = parse(await readWorkflow("release.yml"))
  const steps = quality.jobs.gates.steps
  const bun = steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
  const releaseBun = Object.values(release.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
  assert.ok(bun, "gate tests execute the real Bun bundler")
  assert.equal(bun.if, "matrix.group == 'gate-tests'")
  assert.equal(bun.with["bun-version"], releaseBun.with["bun-version"])
  const buildIndex = steps.findIndex((step) => step.run === "pnpm sidecar:webclone:build")
  const gateIndex = steps.findIndex((step) => step.name === "Run gate group")
  assert.ok(buildIndex >= 0 && buildIndex < gateIndex, "bundle tests consume built webclone output")
  assert.equal(steps[buildIndex].if, "matrix.group == 'gate-tests'")
  assert.ok(steps.indexOf(bun) < buildIndex, "Bun is ready before bundle prerequisites")
})

test("Jest builds prerequisites once and restores them before standalone installation", async () => {
  const workflow = parse(await readWorkflow("test.yml"))
  const job = Object.values(workflow.jobs).find((job) =>
    job.steps?.some((step) => step.run?.includes("Run Jest") || step.name?.includes("Run Jest"))
  )
  assert.ok(job)
  const prerequisites = workflow.jobs["jest-plan"].steps.find(
    (step) => step.name === "Build Jest runtime prerequisites once"
  )
  const prerequisiteIndex = job.steps.findIndex(
    (step) => step.name === "Download built Jest prerequisites"
  )
  const testIndex = job.steps.findIndex((step) => step.name?.includes("Run Jest"))
  assert.ok(prerequisiteIndex >= 0 && prerequisiteIndex < testIndex)
  assert.match(prerequisites.run, /pnpm build:packages/)
  assert.match(prerequisites.run, /pnpm sidecar:webclone:build/)
  const installIndex = job.steps.findIndex((step) => step.run === "pnpm sidecar:webclone:install")
  assert.ok(prerequisiteIndex < installIndex && installIndex < testIndex)
  const workspaceInstall = job.steps.findIndex((step) => step.name === "Install dependencies")
  assert.ok(
    prerequisiteIndex < workspaceInstall,
    "postinstall reuses restored linked-package output"
  )
  assert.ok(!job.steps.some((step) => step.run?.includes("pnpm build:packages")))
  assert.match(job.steps[testIndex].run, /--run-plan .cache\/jest\/plan.json --shard "\$SHARD"/)
  assert.match(job.steps[testIndex].run, /if \[ "\$MODE" = full \]; then args\+=\(--coverage\)/)
})

test("workspace Rust tests report all failing crates with host features enabled", async () => {
  const job = parse(await readWorkflow("test.yml")).jobs["cargo-test-workspace"]
  const tests = job.steps.find(
    (step) => step.name === "Run Rust tests (all crates except src-tauri)"
  )
  assert.match(
    tests.run,
    /cargo test --locked --workspace --exclude cognia-next --no-fail-fast --features/
  )
  assert.match(tests.run, /check-rust-architecture\.mjs --print-ci-features/)
  assert.ok(
    job.steps.some(
      (step) => step.run === "cargo check --locked --workspace --exclude cognia-next --all-targets"
    )
  )
})

test("expensive PR lanes follow runtime impacts without skipping Windows prerequisites", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  for (const [name, impact] of Object.entries({
    "docs-build": "docs",
    "web-build": "web",
    "mobile-android-build": "mobile",
    sidecar: "sidecar",
    conformance: "gateway",
    "build-e2e": "frontend",
    "e2e-browser-extension": "browserExtension",
    "cargo-test-workspace": "rust",
    "postgres-rls": "postgres",
    "cargo-test-diagnostic-server": "diagnostic",
  })) {
    assert.equal(jobs[name].needs, "jest-plan")
    assert.equal(jobs[name].if, `fromJSON(needs.jest-plan.outputs.impacts).${impact}`)
  }
  assert.deepEqual(jobs["cargo-test-windows"].needs, ["jest-plan", "build"])
  assert.match(jobs.build.if, /\.productionBuild$/)
  assert.match(jobs["cargo-test-windows"].if, /\.rust$/)
  assert.match(jobs["e2e-report"].if, /needs.e2e.result != 'skipped'/)
})

test("CI workflows provision their clean-checkout prerequisites", async () => {
  const [quality, report, testWorkflow] = await Promise.all([
    readWorkflow("quality.yml"),
    readWorkflow("report.yml"),
    readWorkflow("test.yml"),
  ])

  assert.match(quality, /sudo apt-get install -y[\s\S]*ripgrep/)
  assert.match(quality, /matrix\.group == 'artifacts'[\s\S]*pnpm plugin-node:prepare/)
  assert.match(report, /pnpm\/action-setup@[\w.-]+[\s\S]*pnpm install --frozen-lockfile/)
  // Each worker needs the larger current type graph, while two workers and
  // recycling idle workers keep the total below the hosted runner's memory.
  assert.match(testWorkflow, /NODE_OPTIONS: "--max-old-space-size=6144"/)
  assert.match(testWorkflow, /--maxWorkers=2/)
  const jestConfig = await readFile(new URL("../../jest.config.ts", import.meta.url), "utf8")
  assert.match(jestConfig, /workerIdleMemoryLimit: isCoverage \? "768MB"/)
  assert.match(testWorkflow, /sidecars:build[\s\S]*sidecars:test/)
  assert.match(testWorkflow, /sidecars:test[\s\S]*sidecar:test:live/)
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
  // The nightly Tauri matrix is the most expensive job in the repo and is
  // gated on `test` for that reason. Asserted, not forbidden: a bundle built
  // from a red tree proves nothing.
  assert.match(nightly, /build-tauri:[\s\S]*needs: test/)
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

test("every Linux desktop compile installs the capture backend's native libraries", async () => {
  for (const name of ["test.yml", "quality.yml", "build-tauri.yml"]) {
    const workflow = parse(await readWorkflow(name))
    const nativeInstalls = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run)
      .filter((run) => typeof run === "string" && run.includes("libgtk-3-dev"))
    assert.ok(nativeInstalls.length > 0, `${name} has native build prerequisites`)
    for (const run of nativeInstalls) {
      assert.match(run, /\blibgbm-dev\b/, `${name} must link GBM for libwayshot-xcap`)
      assert.match(run, /\blibpipewire-0\.3-dev\b/, `${name} must compile PipeWire capture`)
    }
  }
})

test("headless conformance compilation does not stage a desktop bundle", async () => {
  const workflow = parse(await readWorkflow("test.yml"))
  const step = workflow.jobs.conformance.steps.find(
    (step) => step.run === "pnpm conformance:prepare"
  )
  assert.deepEqual(JSON.parse(step.env.TAURI_CONFIG), {
    bundle: { resources: [], externalBin: [] },
  })
  assert.equal(workflow.jobs.conformance.env?.TAURI_CONFIG, undefined)
})

test("the update Worker runs in its Cloudflare Vitest pool, outside root Jest", async () => {
  const config = await readFile(new URL("../../jest.config.ts", import.meta.url), "utf8")
  assert.match(config, /"\/services\/update-server\/worker\/"/)
  const pkg = JSON.parse(
    await readFile(
      new URL("../../services/update-server/worker/package.json", import.meta.url),
      "utf8"
    )
  )
  assert.equal(pkg.scripts.test, "vitest run")
  const workflow = parse(await readWorkflow("share-server.yml"))
  const job = Object.values(workflow.jobs).find((job) =>
    job.strategy?.matrix?.service?.includes("update-server")
  )
  assert.ok(job, "the excluded Worker still has its own CI job")
  assert.ok(job.steps.some((step) => step.run?.includes("pnpm test")))
})

test("quality setup avoids redundant history, native packages and workspace builds", async () => {
  const workflow = parse(await readWorkflow("quality.yml"))
  const steps = workflow.jobs.gates.steps
  assert.equal(
    steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"],
    1
  )
  const native = steps.find((step) => step.name === "Install gate system dependencies")
  assert.equal(native.if, "matrix.rust")
  const audit = steps.find((step) => step.name === "Install audit search dependency")
  assert.equal(audit.if, "matrix.group == 'audit'")
  assert.match(audit.run, /\bripgrep\b/)
  assert.doesNotMatch(audit.run, /libgtk|libwebkit/)
  assert.equal(
    steps.find((step) => step.run === "pnpm build:packages").if,
    "matrix.group == 'plugin-sdk'"
  )
  const { selectGates } = await import("../gates/check-all.mjs")
  assert.equal(selectGates({ group: "artifacts" })[0].script, "build:packages")
  const deployment = parse(await readWorkflow("deploy.yml"))
  const website = Object.values(deployment.jobs).find((job) =>
    job.steps?.some((step) => step.run === "pnpm --filter web build")
  )
  assert.equal(
    website.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"],
    0
  )
})

test("pnpm caches immutable store data but always validates and links frozen installs", async () => {
  for (const name of [
    "quality.yml",
    "report.yml",
    "build-tauri.yml",
    "compose-e2e.yml",
    "release.yml",
    "deploy.yml",
    "share-server.yml",
  ]) {
    const workflow = parse(await readWorkflow(name))
    for (const job of Object.values(workflow.jobs)) {
      const steps = job.steps ?? []
      const installs = steps.filter((step) =>
        /pnpm(?: --dir \S+)? install --frozen-lockfile/.test(step.run ?? "")
      )
      if (!installs.length) continue
      const setupIndex = steps.findIndex((step) => step.uses?.startsWith("pnpm/action-setup@"))
      const cacheIndex = steps.findIndex(
        (step) => step.uses?.startsWith("actions/setup-node@") && step.with?.cache === "pnpm"
      )
      assert.ok(
        setupIndex >= 0 && setupIndex < cacheIndex,
        `${name} discovers the pnpm store after provisioning pnpm`
      )
      for (const install of installs) {
        assert.ok(steps.indexOf(install) > cacheIndex)
        assert.match(install.run, /--frozen-lockfile --prefer-offline/)
        assert.doesNotMatch(
          install.if ?? "",
          /cache-hit/,
          `${name} must not reuse a stale linked dependency tree`
        )
        assert.doesNotMatch(install.run, /--ignore-scripts|--offline(?:\s|$)/)
      }
    }
  }
  const quality = parse(await readWorkflow("quality.yml"))
  const cache = quality.jobs.gates.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@")
  )
  assert.equal(cache.with["cache-dependency-path"], "**/pnpm-lock.yaml")
})

test("standalone Rust caches follow the selected compiler and isolate WASM targets", async () => {
  for (const service of ["share", "signaling"]) {
    const workflow = parse(await readWorkflow(`${service}-server.yml`))
    for (const event of ["push", "pull_request"]) {
      assert.ok(workflow.on[event].paths.includes("rust-toolchain.toml"))
      assert.ok(workflow.on[event].paths.includes(".cargo/**"))
    }
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const cacheIndex = job.steps.findIndex((step) => step.uses === "Swatinem/rust-cache@v2")
      if (service === "share" && jobName === "worker") continue
      assert.ok(cacheIndex > 0)
      const setupIndex = job.steps.findIndex((step) =>
        step.run?.includes("rustup show active-toolchain")
      )
      assert.ok(setupIndex >= 0 && setupIndex < cacheIndex)
      const cache = job.steps[cacheIndex]
      const wasm = jobName === "worker"
      assert.equal(
        cache.with.workspaces,
        `services/${service}-server${wasm ? "/worker" : ""} -> target`
      )
      assert.equal(
        cache.with.key,
        `${service}-server-${wasm ? "wasm32-unknown-unknown" : "native"}`
      )
      assert.notEqual(cache.with["add-rust-environment-hash-key"], false)
      assert.notEqual(cache.with["add-rust-environment-hash-key"], "false")
      assert.ok(
        job.steps
          .slice(cacheIndex + 1)
          .some((step) => /cargo (clippy|check|llvm-cov)/.test(step.run ?? "") && !step.if)
      )
    }
  }
})

test("the signaling deployment packager stays on its verified worker-build release", async () => {
  const workflow = parse(await readWorkflow("signaling-server.yml"))
  const installer = workflow.jobs.worker.steps.find((step) => step.name === "Install worker-build")
  assert.equal(installer.with.tool, "worker-build@0.8.7")
  const verification = workflow.jobs.worker.steps.find(
    (step) => step.name === "Verify worker artifact"
  )
  for (const artifact of ["build/worker/shim.mjs", "build/index.js", "build/index_bg.wasm"]) {
    assert.ok(verification.run.includes(`test -s ${artifact}`))
  }
})

test("Jest shards provision ripgrep before source contract suites execute", async () => {
  const workflow = parse(await readWorkflow("test.yml"))
  const steps = workflow.jobs.test.steps
  const searchIndex = steps.findIndex((step) => /packages=\(ripgrep\)/.test(step.run ?? ""))
  const testIndex = steps.findIndex((step) => step.name === "Run Jest planned shard")
  assert.ok(searchIndex >= 0 && searchIndex < testIndex)
  assert.equal(steps[searchIndex].if, undefined)
})

test("Jest builds selected sandbox helpers once and preserves executable artifact modes", async () => {
  const workflow = parse(await readWorkflow("test.yml"))
  const prep = workflow.jobs["jest-plan"].steps
  const plan = prep.find((step) => step.id === "plan")
  const build = prep.find((step) => step.name === "Build selected Jest native helpers once")
  assert.match(plan.run, /plan\.testFiles\.some/)
  assert.match(plan.run, /coding-loop\.bundle\.test\.ts/)
  assert.match(plan.run, /os-sandbox-exec\.test\.ts/)
  assert.equal(build.if, "steps.plan.outputs.native-helpers == 'true'")
  assert.match(build.run, /cargo build --locked -p cognia-exec-sandbox/)
  assert.match(build.run, /--bin cognia-sandbox-exec --bin cognia-external-agent-launcher -j 2/)
  assert.match(build.run, /tar -cf \.cache\/jest\/native-helpers\.tar/)
  const upload = prep.find((step) => step.name === "Publish built Jest prerequisites")
  assert.equal(upload.with["include-hidden-files"], true)
  assert.match(upload.with.path, /native-helpers\.tar/)
  const shard = workflow.jobs.test.steps
  const restore = shard.findIndex(
    (step) => step.name === "Install source contract and selected native prerequisites"
  )
  const run = shard.findIndex((step) => step.name === "Run Jest planned shard")
  assert.ok(restore >= 0 && restore < run)
  assert.match(shard[restore].run, /plan\.shards\.find/)
  assert.match(shard[restore].run, /shard\.testFiles\.some/)
  assert.match(shard[restore].run, /tar -xf/)
  assert.match(shard[restore].run, /packages\+=\(bubblewrap apparmor\)/)
  assert.match(shard[restore].run, /if \[ "\$native_helpers" = true \]; then/)
  assert.match(
    shard[restore].run,
    /profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\s+userns,/
  )
  assert.match(shard[restore].run, /sudo apparmor_parser -r \/etc\/apparmor.d\/cognia-ci-bwrap/)
  assert.match(
    shard[restore].run,
    /\/usr\/bin\/bwrap --unshare-user --unshare-net --ro-bind \/ \/ -- \/bin\/true/
  )
  assert.doesNotMatch(shard[restore].run, /sysctl|apparmor_restrict_unprivileged_userns=0/)
  assert.equal(
    shard.flatMap((step) => (step.run ?? "").match(/sudo apt-get update/g) ?? []).length,
    1
  )
})

test("Playwright helper unit tests belong only to the Jest Node project", async () => {
  const config = await readFile(new URL("../../jest.config.ts", import.meta.url), "utf8")
  const ignore = config.match(/"(\/tests\/e2e\/[^"\n]*)"/)[1]
  const ignored = new RegExp(JSON.parse(`"${ignore}"`))
  assert.equal(ignored.test("/repo/tests/e2e/helpers/shared-chat.test.ts"), false)
  assert.equal(ignored.test("/repo/tests/e2e/helpers/nested/example.test.ts"), false)
  assert.equal(ignored.test("/repo/tests/e2e/web/account-first-run.spec.ts"), true)
  assert.equal(ignored.test("/repo/tests/e2e/helpers/example.spec.ts"), true)
  assert.ok(config.includes("${POSIX_ROOT_DIR}/tests/e2e/helpers/**/*.test.ts"))
  assert.ok(config.includes('"<rootDir>/tests/e2e/helpers/.*\\\\.test\\\\.ts$"'))
})

test("every root install restores standalone npm downloads before postinstall", async () => {
  for (const workflow of [
    "test.yml",
    "quality.yml",
    "build-tauri.yml",
    "release.yml",
    "deploy.yml",
    "compose-e2e.yml",
    "report.yml",
  ]) {
    const { jobs } = parse(await readWorkflow(workflow))
    for (const [name, job] of Object.entries(jobs)) {
      const steps = job.steps ?? []
      const install = steps.findIndex(
        (step) => /pnpm install/.test(step.run ?? "") && !step["working-directory"]
      )
      if (install < 0) continue
      const cache = steps.findIndex(
        (step) => step.uses?.startsWith("actions/cache@") && step.with.path === "~/.npm"
      )
      assert.ok(
        cache >= 0 && cache < install,
        `${workflow}:${name} restores npm downloads before root postinstall`
      )
      for (const token of [
        "runner.os",
        "runner.arch",
        "node26",
        "sidecar/vscode-ext-host/package-lock.json",
        "sidecar/webclone/package-lock.json",
      ]) {
        assert.ok(
          steps[cache].with.key.includes(token),
          `${workflow}:${name} npm cache key includes ${token}`
        )
      }
      assert.ok(steps[cache].with["restore-keys"].includes("runner.arch"))
      assert.ok(!steps[install].run.includes("--ignore-scripts"))
    }
  }
})

test("workspace Rust integration tests provision media, sidecar, and sandbox prerequisites", async () => {
  const { steps } = parse(await readWorkflow("test.yml")).jobs["cargo-test-workspace"]
  const testIndex = steps.findIndex(
    (step) => step.name === "Run Rust tests (all crates except src-tauri)"
  )
  const system = steps.find((step) => step.name === "Install system dependencies")
  for (const dependency of ["ffmpeg", "bubblewrap", "apparmor"]) {
    assert.match(system.run, new RegExp(`\\b${dependency}\\b`))
  }
  const node = steps.find((step) => step.uses === "actions/setup-node@v7")
  assert.equal(node.with["node-version"], "26.x")
  assert.equal(node.with.cache, "pnpm")
  assert.equal(node.with["cache-dependency-path"], "sidecar/pnpm-lock.yaml")
  const install = steps.findIndex((step) => step.name === "Install standalone sidecar dependencies")
  assert.ok(
    install > steps.findIndex((step) => step.uses === "pnpm/action-setup@v6") && install < testIndex
  )
  assert.equal(steps[install]["working-directory"], "sidecar")
  assert.equal(steps[install].run, "pnpm install --frozen-lockfile --prefer-offline")
  assert.ok(
    !steps.some(
      (step) =>
        step.run === "pnpm install --frozen-lockfile --prefer-offline" && !step["working-directory"]
    )
  )
  const sandbox = steps.findIndex(
    (step) => step.name === "Enable bwrap user namespaces for sandbox tests"
  )
  assert.ok(sandbox >= 0 && sandbox < testIndex)
  assert.match(steps[sandbox].run, /profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\)/)
  assert.match(steps[sandbox].run, /userns,/)
  assert.match(steps[sandbox].run, /sudo apparmor_parser -r \/etc\/apparmor.d\/cognia-ci-bwrap/)
  assert.match(
    steps[sandbox].run,
    /\/usr\/bin\/bwrap --unshare-user --unshare-net --ro-bind \/ \/ -- \/bin\/true/
  )
  assert.doesNotMatch(steps[sandbox].run, /sysctl|apparmor_restrict_unprivileged_userns=0/)
})

test("Windows Rust unit tests reuse the export without staging a desktop bundle", async () => {
  const workflow = parse(await readWorkflow("test.yml"))
  const job = workflow.jobs["cargo-test-windows"]
  const step = job.steps.find((step) => step.run === "cargo test --locked")
  assert.deepEqual(JSON.parse(step.env?.TAURI_CONFIG ?? "{}"), {
    bundle: { resources: [], externalBin: [] },
  })
  assert.equal(job.env?.TAURI_CONFIG, undefined)
  assert.ok(
    job.steps.some((step) => step.with?.name === "nextjs-build" && step.with?.path === "out/")
  )
  const tauri = JSON.parse(
    await readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")
  )
  assert.ok(tauri.bundle.externalBin.includes("binaries/cognia-server"))
  assert.ok(tauri.bundle.externalBin.includes("binaries/cognia-external-agent-launcher"))
})
