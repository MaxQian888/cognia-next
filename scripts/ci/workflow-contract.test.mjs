import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { parse } from "yaml"

const readWorkflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")

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
  assert.match(cache.with["cache-dependency-path"], /matrix.group == 'types'.*\*\*\/pnpm-lock.yaml/)
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
