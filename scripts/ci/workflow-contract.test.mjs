import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { parse } from "yaml"
import { ESLint } from "eslint"

const readWorkflow = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")

test("website extraction removes the old workspace from install and release metadata", async () => {
  const [workspace, lockfile, changesets] = await Promise.all(
    ["pnpm-workspace.yaml", "pnpm-lock.yaml", ".changeset/config.json"].map((file) =>
      readFile(new URL(`../../${file}`, import.meta.url), "utf8")
    )
  )
  assert.ok(!parse(workspace).packages.includes("web"))
  assert.ok(!/^ {2}web:/m.test(lockfile), "pnpm-lock.yaml must not retain the website importer")
  assert.ok(!JSON.parse(changesets).ignore.includes("web"))
})

test("website extraction removes tracked source and keeps docs deployment current", async () => {
  const root = new URL("../../", import.meta.url)
  assert.equal(
    execFileSync("git", ["ls-files", "--", "web/"], { cwd: root, encoding: "utf8" }).trim(),
    ""
  )
  const deployment = parse(await readWorkflow("deploy.yml"))
  assert.deepEqual(deployment.on.workflow_dispatch.inputs.target.options, ["all", "docs"])
  assert.deepEqual(deployment.jobs.summary.needs, ["gate", "deploy-docs"])
  assert.equal(deployment.jobs["deploy-web"], undefined)
  const guide = await readFile(new URL("../../docs/development/CI_CD.md", import.meta.url), "utf8")
  assert.doesNotMatch(guide, /CF_WEB_PAGES_PROJECT|web\/out/)
})

test("website extraction removes retired local launch commands", async () => {
  const [packageJson, claudeLaunch, vscodeLaunch] = await Promise.all(
    ["package.json", ".claude/launch.json", ".vscode/launch.json"].map((file) =>
      readFile(new URL(`../../${file}`, import.meta.url), "utf8")
    )
  )
  assert.ok(Object.keys(JSON.parse(packageJson).scripts).every((name) => !name.startsWith("web:")))
  const args = JSON.parse(claudeLaunch).configurations.flatMap((config) => config.runtimeArgs ?? [])
  assert.ok(args.every((arg) => !/^web(?:\/|:|$)/.test(arg)))
  assert.doesNotMatch(vscodeLaunch, /pnpm web:/)
})

test("website extraction keeps bilingual onboarding and ignore rules current", async () => {
  for (const file of ["README.md", "README_zh.md"]) {
    const readme = await readFile(new URL(`../../${file}`, import.meta.url), "utf8")
    assert.ok(
      readme.includes("https://github.com/cognia-labs/cognia-website"),
      `${file}: website repository link`
    )
    assert.ok(!/\bpnpm web:[a-z:-]+/.test(readme), `${file}: no retired website commands`)
    assert.ok(!/[├└]── web\//u.test(readme), `${file}: no retired website directory`)
  }
  const ignored = await readFile(new URL("../../.gitignore", import.meta.url), "utf8")
  assert.doesNotMatch(ignored, /^\/web\//m)
})

test("Jest bundle suites consume a verified artifact from the frozen plan", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  const producer = jobs["jest-plan"].steps
  const freeze = producer.findIndex((step) => step.id === "plan")
  const bundle = producer.findIndex(
    (step) => step.run === "node scripts/test/cli-bundle.mjs prepare .cache/jest/plan.json"
  )
  const upload = producer.findIndex((step) => step.name === "Publish prepared Jest CLI bundle")
  assert.ok(freeze >= 0 && freeze < bundle && bundle < upload)
  assert.match(producer[upload].with.path, /cli-bundle\.tar/)
  assert.match(producer[upload].with.path, /cli-bundle\.json/)
  assert.equal(producer[upload].if, "steps.cli-bundle.outputs.prepared == 'true'")
  assert.equal(producer[upload].with.name, "jest-cli-bundle-${{ github.sha }}")
  assert.ok(
    !producer
      .find((step) => step.name === "Publish built Jest prerequisites")
      .with.path.includes("cli-bundle")
  )
  const consumer = jobs.test.steps
  const restore = consumer.findIndex(
    (step) => step.run === 'node scripts/test/cli-bundle.mjs restore .cache/jest/plan.json "$SHARD"'
  )
  const run = consumer.findIndex((step) => step.name === "Run Jest planned shard")
  assert.ok(restore > consumer.findIndex((step) => step.name === "Download frozen Jest test plan"))
  assert.ok(restore < run)
  const download = consumer.findIndex((step) => step.name === "Download selected Jest CLI bundle")
  assert.ok(download < restore)
  assert.equal(consumer[download].if, "steps.cli-bundle.outputs.required == 'true'")
  assert.equal(consumer[download].with.name, producer[upload].with.name)
  assert.equal(consumer[download].with.path, ".cache/jest/")
  const select = consumer.findIndex((step) => step.id === "cli-bundle")
  assert.ok(select < download)
  assert.match(consumer[select].run, /cli-bundle\.mjs required/)
  assert.equal(consumer[run].env.COGNIA_JEST_CLI_BUNDLE, ".cache/jest/cli-bundle.json")
  for (const suite of ["entry.bundle", "coding-loop.bundle"]) {
    const source = await readFile(
      new URL(`../../cli/src/cli/${suite}.test.ts`, import.meta.url),
      "utf8"
    )
    assert.match(source, /scripts\/test\/cli-bundle\.mjs/)
    assert.ok(!source.includes('"scripts/build/build-cli.mjs"'))
  }
})

test("Quality Cargo caches isolate matrix producers and retain failed trunk builds", async () => {
  const { jobs } = parse(await readWorkflow("quality.yml"))
  const cache = jobs.gates.steps.find((step) => step.uses?.startsWith("Swatinem/rust-cache@"))
  assert.equal(cache.if, "matrix.rust")
  assert.equal(cache.with.key, "quality-${{ matrix.group }}")
  assert.equal(cache.with["cache-on-failure"], true)
  assert.equal(
    cache.with["save-if"],
    "${{ github.ref == 'refs/heads/dev' || github.ref == 'refs/heads/master' }}"
  )
  assert.equal(cache.with["shared-key"], undefined)
})

test("server images share one builder and retain intermediate caches and Cargo diagnostics", async () => {
  const job = parse(await readWorkflow("images.yml")).jobs["cognia-server-image"]
  const full = job.steps.find((step) => step.id === "build-full")
  const slim = job.steps.find((step) => step.id === "build-slim")
  assert.equal(job["runs-on"], "ubuntu-latest")
  assert.equal(
    job.steps.filter((step) => step.uses?.startsWith("docker/setup-buildx-action@")).length,
    1
  )
  assert.ok(job.steps.indexOf(full) < job.steps.indexOf(slim))
  assert.equal(full.with.target, "runtime-full")
  assert.equal(slim.with.target, "runtime-slim")
  assert.match(full.with["cache-to"], /mode=max,compression=zstd,compression-level=3/)
  assert.doesNotMatch(full.with["cache-to"], /force-compression=true/)
  assert.equal(slim.with["cache-to"], undefined)
  const timings = job.steps.find((step) => step.with?.target === "build-timings")
  assert.ok(job.steps.indexOf(timings) > job.steps.indexOf(slim))
  assert.equal(timings.with["cache-to"], undefined)
  assert.equal(timings.with.outputs, "type=local,dest=${{ runner.temp }}/server-cargo-timings")
  assert.ok(
    job.steps.some(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with?.name === "server-cargo-timings"
    )
  )
})

test("iOS tagged releases verify the IPA before uploading to TestFlight and gate publication", async () => {
  const { jobs } = parse(await readWorkflow("release.yml"))
  const ios = jobs["build-ios"]
  assert.ok(ios)
  assert.deepEqual(ios.needs, ["quality", "test"])
  assert.equal(ios.permissions.contents, "read")
  const steps = ios.steps
  const build = steps.findIndex((s) => s.name === "Build offline iOS assets")
  const preflight = steps.findIndex((s) => s.id === "ios-signing")
  const archive = steps.findIndex((s) => s.run === "node mobile/scripts/ios-release.mjs package")
  const upload = steps.findIndex((s) =>
    s.uses?.startsWith("apple-actions/upload-testflight-build@")
  )
  assert.ok(build >= 0 && build < preflight && preflight < archive && archive < upload)
  assert.match(steps[build].run, /pnpm mobile:prepare/)
  assert.match(steps[build].run, /pnpm --filter mobile run sync:ios/)
  assert.equal(ios.env.NEXT_PUBLIC_PLATFORM, "mobile")
  assert.equal(ios.env.COGNIA_MOBILE_DEV, "0")
  assert.equal(steps[upload].with["app-path"], "${{ steps.ios-package.outputs.ipa_path }}")
  // Stage build numbers repeat across marketing versions; upstream polling does not
  // filter the marketing version and could incorrectly accept an older build.
  assert.equal(steps[upload].with["wait-for-processing"], "false")
  assert.equal(steps.find((s) => s.name === "Clean up iOS signing").if, "always()")
  assert.equal(ios.env.IOS_CERTIFICATE_PASSWORD, undefined)
  assert.ok(jobs["build-tauri"].needs.includes("build-ios"))
  assert.ok(
    steps.some(
      (s) => s.uses?.startsWith("actions/upload-artifact@") && s.with.name === "ios-release"
    )
  )
  assert.ok(!steps.some((s) => /submit.*review|release.*app/.test(s.run ?? "")))
})

test("tagged releases require verified Android artifacts before publishing the desktop draft", async () => {
  const { jobs } = parse(await readWorkflow("release.yml"))
  const android = jobs["build-android"]
  assert.ok(android, "Android is part of the release job graph")
  assert.deepEqual(android.needs, ["quality", "test"])
  assert.equal(android.permissions.contents, "read")
  const preflight = android.steps.findIndex((s) => s.id === "android-signing")
  const build = android.steps.findIndex((s) => s.run === "pnpm mobile:build:android --release")
  const sign = android.steps.findIndex(
    (s) => s.run === "node mobile/scripts/android-release.mjs package"
  )
  const upload = android.steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact@"))
  assert.ok(preflight >= 0 && preflight < build && build < sign && sign < upload)
  assert.equal(android.steps[upload].with.name, "android-release")
  assert.equal(android.steps[upload].with["if-no-files-found"], "error")
  assert.ok(jobs["build-tauri"].needs.includes("build-android"))
  assert.equal(jobs["build-tauri"].with.androidArtifact, "android-release")
  const cleanup = android.steps.find((s) => s.name === "Remove temporary signing material")
  assert.equal(cleanup.if, "always()")
  assert.equal(android.env?.ANDROID_KEYSTORE_PASSWORD, undefined)
  assert.equal(android.steps[build].env?.ANDROID_KEYSTORE_PASSWORD, undefined)
  assert.match(android.steps[preflight].env.ANDROID_SIGNING_CERT_SHA256, /secrets\./)
})

test("publication attaches Android artifacts and keeps prereleases out of latest", async () => {
  const workflow = parse(await readWorkflow("build-tauri.yml"))
  assert.equal(workflow.on.workflow_call.inputs.androidArtifact.default, "")
  const steps = workflow.jobs["publish-release"].steps
  const download = steps.findIndex((s) => s.uses?.startsWith("actions/download-artifact@"))
  const upload = steps.findIndex((s) => s.name === "Attach verified Android release")
  const publish = steps.findIndex((s) => s.name === "Publish verified release")
  assert.ok(download >= 0 && download < upload && upload < publish)
  assert.equal(steps[download].if, "inputs.androidArtifact != ''")
  assert.equal(steps[upload].if, "inputs.androidArtifact != ''")
  assert.match(steps[upload].run, /gh release upload/)
  assert.match(steps[upload].run, /sha256sum --check/)
  assert.match(steps[publish].run, /--prerelease --latest=false/)
  assert.match(steps[publish].run, /--draft=false --latest/)
})

test("frontend build caches cover each build mode without sharing incompatible compilation state", async () => {
  const scopes = new Set()
  for (const [workflow, jobName, cachePath] of [
    ["test.yml", "build", ".next/cache"],
    ["test.yml", "build-e2e", ".next/cache"],
    ["test.yml", "docs-build", "docs/.next/cache"],
    ["test.yml", "mobile-android-build", ".next/cache"],
    ["test.yml", "mobile-ios-build", ".next/cache"],
    ["test.yml", "e2e-tauri", ".next/cache"],
    ["build-tauri.yml", "build-tauri", ".next/cache"],
    ["deploy.yml", "deploy-docs", "docs/.next/cache"],
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
    }
  }
})

test("Linux frontend consumers reuse this run's compiled packages before frozen install", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  for (const name of ["docs-build", "mobile-android-build", "sidecar", "build", "build-e2e"]) {
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
        const installs = (job.steps ?? []).filter((entry) => /pnpm install\b/.test(entry.run ?? ""))
        if (
          installs.length > 0 &&
          installs.every((entry) => {
            const directory = entry["working-directory"] ?? job.defaults?.run?.["working-directory"]
            return directory && directory !== "." && locks === `${directory}/pnpm-lock.yaml`
          })
        )
          continue
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
  assert.ok(config.includes('"/packages/agent-dsh/runtime/.*\\\\.test\\\\.mjs$"'))
  const { jobs } = parse(await readWorkflow("test.yml"))
  const job = jobs["deepseek-runtime"]
  assert.equal(job.needs, "jest-plan")
  assert.equal(job.if, "fromJSON(needs.jest-plan.outputs.impacts).deepseekRuntime")
  const install = job.steps.find((step) => step.name === "Install isolated runtime")
  assert.match(install.run, /cp packages\/agent-dsh\/runtime\/\* "\$DSH_TEST_ROOT\/"/)
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
  assert.match(build.with.outputs, /cargo-only == 'true' && 'type=cacheonly'/)
  assert.match(build.with.outputs, /should_push == 'true'/)
  assert.match(build.with.outputs, /push-by-digest=true,name-canonical=true,push=true/)
  assert.match(build.with.outputs, /\|\| 'type=docker'/)
  assert.match(build.with.tags, /\|\| 'cognia-agent-bundle:smoke'/)
  assert.match(build.with["cache-from"], /buildcache-\$\{\{ matrix.arch \}\}/)
  assert.match(build.with["cache-to"], /should_push == 'true'/)
  assert.match(build.with["cache-to"], /matrix.arch/)
  const smoke = job.steps.find((step) => step.name === "Smoke against user images")
  assert.equal(smoke.if, "needs.vars.outputs.cargo-only != 'true'")
  assert.match(build.with.target, /cargo-only == 'true' && 'sandboxd'/)
  // Tags/manual publication never qualify for the dependency-only PR branch.
  const { isCargoDependencyChange } = await import("./change-plan.mjs")
  assert.equal(isCargoDependencyChange({ mode: "full", changedFiles: [], deletedFiles: [] }), false)
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
  assert.equal(
    metadata.with.tags,
    `${otherMetadata.with.tags}type=raw,value=latest-full,enable=\${{ matrix.variant == 'full' && startsWith(github.ref, 'refs/tags/v') }}\n`,
    "preserve release and SHA tags plus the full-variant alias"
  )
  assert.deepEqual(merge.strategy.matrix.variant, ["full", "codex"])
  assert.equal(
    metadata.with.flavor,
    "suffix=${{ matrix.variant == 'codex' && '-codex' || '' }},onlatest=true"
  )
  const download = merge.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))
  assert.equal(download.with.pattern, "agent-bundle-digest-${{ matrix.variant }}-*")
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
    await writeFile(join(dir, "docker"), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$DOCKER_LOG"\n', {
      mode: 0o755,
    })
    const run = (variant) =>
      execFileSync("bash", ["-euo", "pipefail", "-c", step.run], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          DOCKER_LOG: log,
          DIGEST_DIR: dir,
          VARIANT: variant,
          IMAGE: "ghcr.io/example/cognia-agent-bundle",
          TAGS: "ghcr.io/example/cognia-agent-bundle:1.2.3\nghcr.io/example/cognia-agent-bundle:latest",
        },
        stdio: "pipe",
      })
    for (const variant of ["full", "codex"]) {
      await writeFile(log, "")
      await writeFile(join(dir, `${variant}-amd64.txt`), `${digestA}\n`)
      await writeFile(join(dir, `${variant}-arm64.txt`), `${digestB}\n`)
      run(variant)
      const calls = await readFile(log, "utf8")
      assert.match(calls, /buildx\nimagetools\ncreate\n--tag\n.*:1\.2\.3\n--tag\n.*:latest\n/)
      assert.ok(calls.includes(`ghcr.io/example/cognia-agent-bundle@${digestA}`))
      assert.ok(calls.includes(`ghcr.io/example/cognia-agent-bundle@${digestB}`))
      await writeFile(log, "")
      await writeFile(join(dir, `${variant}-arm64.txt`), "not-a-digest\n")
      assert.throws(() => run(variant))
      assert.equal(await readFile(log, "utf8"), "", "invalid ARM digest must not promote AMD alone")
      await rm(join(dir, `${variant}-arm64.txt`))
      assert.throws(() => run(variant))
      assert.equal(
        await readFile(log, "utf8"),
        "",
        "missing ARM smoke artifact must block publication"
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("all Jest waves execute one immutable plan for the exact checkout", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  assert.equal(jobs.test.needs, "jest-plan")
  assert.ok(jobs["jest-plan"].steps.some((step) => step.uses?.startsWith("actions/cache/restore@")))
  assert.ok(!jobs.test.steps.some((step) => step.uses?.startsWith("actions/cache/restore@")))
  const publish = jobs["jest-plan"].steps.find(
    (step) => step.name === "Publish immutable test plan"
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
  const changes = jobs["jest-plan"].steps.find((step) => step.name === "Resolve committed changes")
  assert.equal(changes.env.PR_BASE_SHA, "${{ github.event.pull_request.base.sha }}")
  assert.equal(changes.env.PUSH_BEFORE_SHA, "${{ github.event.before }}")
  assert.match(planning.run, /--plan --change-plan \.cache\/ci\/changes\.json/)
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
    "mobile-android-build": "mobile",
    sidecar: "sidecar",
    conformance: "gateway",
    "build-e2e": "frontend",
    "e2e-browser-extension": "browserExtension",
    "cargo-test-workspace": "rust",
    "postgres-rls": "postgres",
    "cognia-services": "cogniaServices",
  })) {
    assert.equal(jobs[name].needs, "jest-plan")
    const condition = ["e2e-browser-extension", "cognia-services"].includes(name)
      ? `\${{ !cancelled() && (needs.jest-plan.result != 'success' || fromJSON(needs.jest-plan.outputs.impacts).${impact}) }}`
      : `fromJSON(needs.jest-plan.outputs.impacts).${impact}`
    assert.equal(jobs[name].if, condition)
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
  assert.equal(parse(testWorkflow).jobs["web-build"], undefined)
  assert.equal(parse(await readWorkflow("deploy.yml")).jobs["deploy-web"], undefined)
  assert.match(testWorkflow, /mobile-android-build:[\s\S]*assembleDebug/)
  // The nightly Tauri matrix is the most expensive job in the repo and is
  // gated on quality and tests for that reason: a bundle built
  // from a red tree proves nothing.
  assert.deepEqual(parse(nightly).jobs["build-tauri"].needs, ["quality", "test"])
})

test("formatting and lint exclude generated test artifacts", async () => {
  const [prettierIgnore, eslintConfig] = await Promise.all([
    readFile(new URL("../../.prettierignore", import.meta.url), "utf8"),
    readFile(new URL("../../eslint.config.mjs", import.meta.url), "utf8"),
  ])
  assert.match(prettierIgnore, /^\.cache\/$/m)
  assert.match(eslintConfig, /"public\/_cognia\/\*\*"/)
  assert.match(eslintConfig, /"playwright-report\/\*\*"/)
  assert.match(eslintConfig, /"test-results\/\*\*"/)
  assert.match(eslintConfig, /"\.cache\/\*\*"/)
  assert.match(eslintConfig, /"\.tmp\/\*\*"/)
  const eslint = new ESLint({ cwd: fileURLToPath(new URL("../..", import.meta.url)) })
  for (const path of [
    ".cache/capture/chunks/app.js",
    ".tmp/coverage/report.js",
    ".codex-tmp/coverage/lcov-report/block-navigation.js",
    "tmp/repro.mjs",
    "plugins/example/.venv/lib/vendor.js",
    "public/plugins/cognia-pdf/dist/index.js",
  ]) {
    assert.equal(await eslint.isPathIgnored(path), true, path)
  }
  for (const path of ["public/_worker.js", "plugins/cognia-laya-guard/src/index.ts"]) {
    assert.equal(await eslint.isPathIgnored(path), false, path)
  }
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
    "matrix.group == 'plugin-sdk' && steps.prereq-cache.outputs.cache-hit != 'true'"
  )
  const { selectGates } = await import("../gates/check-all.mjs")
  assert.equal(selectGates({ group: "artifacts" })[0].script, "build:packages")
})

test("pnpm caches immutable store data but always validates and links frozen installs", async () => {
  for (const name of [
    "quality.yml",
    "report.yml",
    "build-tauri.yml",
    "compose-e2e.yml",
    "release.yml",
    "deploy.yml",
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

const TRUNK = "github.ref == 'refs/heads/dev' || github.ref == 'refs/heads/master'"

test("only PR runs cancel superseded work; trunk runs always complete", async () => {
  for (const name of ["ci.yml", "quality.yml", "test.yml"]) {
    const workflow = parse(await readWorkflow(name))
    assert.equal(
      workflow.concurrency["cancel-in-progress"],
      "${{ github.event_name == 'pull_request' }}",
      `${name}: a cancelled trunk run publishes no timings, coverage baseline or caches`
    )
  }
})

test("Rust caches are written only by trunk runs and restored everywhere", async () => {
  for (const name of ["quality.yml", "test.yml"]) {
    const { jobs } = parse(await readWorkflow(name))
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses !== "Swatinem/rust-cache@v2") continue
        assert.equal(step.with["save-if"], `\${{ ${TRUNK} }}`, `${name}:${jobName}`)
      }
    }
  }
})

test("every CI job bounds its runtime below the six-hour platform default", async () => {
  for (const name of ["ci.yml", "quality.yml", "test.yml"]) {
    const { jobs } = parse(await readWorkflow(name))
    for (const [jobName, job] of Object.entries(jobs)) {
      if (job.uses) continue
      assert.ok(Number(job["timeout-minutes"]) > 0, `${name}:${jobName} declares timeout-minutes`)
    }
  }
})

test("lint and format results are restored on PRs and written only by cold trunk runs", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")
  )
  assert.match(
    packageJson.scripts.lint,
    /--cache --cache-strategy content --cache-location \.cache\/eslint/
  )
  assert.match(
    packageJson.scripts["format:check"],
    /--cache --cache-strategy content --cache-location \.cache\/prettier/
  )
  const steps = parse(await readWorkflow("quality.yml")).jobs.gates.steps
  const restore = steps.find((step) => step.name === "Restore lint result cache")
  const gate = steps.findIndex((step) => step.name === "Run gate group")
  const save = steps.find((step) => step.name === "Save lint result cache")
  assert.ok(restore.uses.startsWith("actions/cache/restore@"))
  assert.ok(save.uses.startsWith("actions/cache/save@"))
  assert.match(restore.if, /github\.event_name == 'pull_request'/)
  assert.equal(restore.with["lookup-only"], "${{ github.event_name != 'pull_request' }}")
  assert.ok(save.if.includes(`github.event_name == 'push' && (${TRUNK})`))
  assert.ok(save.if.includes("!cancelled()"))
  assert.ok(save.if.includes("steps.gates.outputs.lint-cache-ready == 'true'"))
  assert.ok(save.if.includes("steps.lint-result-cache.outputs.cache-hit != 'true'"))
  assert.equal(steps[gate].id, "gates")
  assert.equal(steps[gate]["continue-on-error"], undefined)
  assert.ok(steps.indexOf(restore) < gate && gate < steps.indexOf(save))
  assert.equal(restore.with.path, save.with.path)
  assert.equal(restore.with.key, save.with.key)
  assert.equal(restore.with.key, "${{ steps.lint-cache-key.outputs.key }}")
  assert.equal(restore.with["restore-keys"], "${{ steps.lint-cache-key.outputs.prefix }}")
  const key = steps.find((step) => step.id === "lint-cache-key")
  assert.ok(steps.indexOf(key) < steps.indexOf(restore))
  for (const input of [
    "runner.arch",
    "pnpm-lock.yaml",
    "eslint.config",
    "tsconfig",
    "sidecar/src",
    "sidecar/**/pnpm-lock.yaml",
    "sidecar/**/package-lock.json",
    "sidecar/**/package.json",
    "packages/*/src",
    "packages/*/package.json",
    "lib/**",
    "types/**",
  ]) {
    assert.ok(key.env.CACHE_PREFIX.includes(input), `cache identity includes ${input}`)
  }
})

test("reports download only frozen input IDs and preserve singleton artifact directories", async () => {
  const steps = parse(await readWorkflow("report.yml")).jobs.report.steps
  const build = steps.findIndex((step) => step.name === "Build the report")
  for (const [scope, name, destination] of [
    ["current", "Download this run's artifacts", "artifacts"],
    ["baseline", "Download the baseline artifacts", "baseline"],
  ]) {
    const select = steps.find((step) => step.id === `${scope}-artifacts`)
    const download = steps.find((step) => step.name === name)
    const verify = steps.find((step) => step.run?.includes(`--scope ${scope} --verify`))
    assert.ok(select && download && verify)
    assert.match(select.run, new RegExp(`--scope ${scope} --run-id`))
    assert.equal(
      download.with["artifact-ids"],
      `\${{ steps.${scope}-artifacts.outputs.artifact-ids }}`
    )
    assert.equal(
      download.with.path,
      `${destination}/\${{ steps.${scope}-artifacts.outputs.single-name }}`
    )
    assert.equal(download.with["digest-mismatch"], "error")
    assert.equal(download.with["merge-multiple"], false)
    assert.equal(download.if, `steps.${scope}-artifacts.outputs.artifact-ids != ''`)
    assert.ok(steps.indexOf(select) < steps.indexOf(download))
    assert.ok(steps.indexOf(download) < steps.indexOf(verify) && steps.indexOf(verify) < build)
    for (const step of [select, download, verify])
      assert.equal(step["continue-on-error"], undefined)
    assert.equal(select.env.REPORT_ARTIFACT_MANIFEST, verify.env.REPORT_ARTIFACT_MANIFEST)
  }
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))
  assert.equal(checkout.with?.ref, undefined, "report code remains on trusted base checkout")
  assert.match(steps[build].run, /github\.event\.workflow_run\.conclusion/)
})

test("compiled workspace prerequisites reuse only exact-source trunk builds", async () => {
  const jobs = parse(await readWorkflow("test.yml")).jobs
  const steps = jobs["jest-plan"].steps
  const key = steps.find((step) => step.id === "prereq-key")
  const restore = steps.find((step) => step.id === "prereq-cache")
  const install = steps.findIndex((step) => step.name === "Install dependencies")
  const build = steps.find((step) => step.name === "Build Jest runtime prerequisites once")
  const save = steps.find((step) => step.name === "Save compiled workspace prerequisites cache")
  // Key is taken from the pristine checkout, before install or build can write
  // into hashed directories; the save then uses that same key.
  assert.ok(steps.indexOf(key) < steps.indexOf(restore) && steps.indexOf(restore) < install)
  assert.ok(steps.indexOf(build) < steps.indexOf(save))
  assert.equal(restore.if, "github.event_name == 'pull_request'")
  assert.ok(save.if.startsWith(`github.event_name == 'push' && (${TRUNK})`))
  assert.equal(restore.with["restore-keys"], undefined, "a prefix match restores stale output")
  assert.equal(restore.with.key, "${{ steps.prereq-key.outputs.key }}")
  assert.equal(save.with.key, restore.with.key)
  assert.equal(save.with.path, restore.with.path)
  for (const input of [
    "packages/**",
    "sidecar/src/**",
    "types/**",
    "scripts/build/**",
    "pnpm-lock.yaml",
  ]) {
    assert.ok(key.run.includes(`'${input}'`), `prerequisite key hashes ${input}`)
  }
  assert.match(build.run, /if \[ "\$PREREQS_CACHED" = true \]/)

  const quality = parse(await readWorkflow("quality.yml")).jobs.gates.steps
  const sdkRestore = quality.find((step) => step.id === "prereq-cache")
  assert.equal(sdkRestore.with.path, restore.with.path)
  assert.equal(sdkRestore.with["restore-keys"], undefined)
  assert.equal(
    sdkRestore.with.key,
    key.run.match(/key=(.*)" >>/)[1],
    "quality restores the exact entry the test planner saves"
  )
  assert.ok(
    quality.indexOf(sdkRestore) <
      quality.findIndex((step) => step.run === "pnpm install --frozen-lockfile --prefer-offline")
  )
})

test("Quality and Jest resolve changes before install and use the same Git-only planner", async () => {
  for (const [workflow, jobName] of [
    ["quality.yml", "prepare"],
    ["test.yml", "jest-plan"],
  ]) {
    const job = parse(await readWorkflow(workflow)).jobs[jobName]
    const index = job.steps.findIndex((step) => step.name === "Resolve committed changes")
    assert.ok(index >= 0, `${workflow} resolves a shared change manifest`)
    assert.equal(
      job.steps[index].run,
      "node scripts/ci/change-plan.mjs --output .cache/ci/changes.json"
    )
    const install = job.steps.findIndex((step) => step.name === "Install dependencies")
    assert.ok(install === -1 || index < install)
    assert.equal(job.permissions.actions, "read")
  }
})

test("every reusable planner caller grants the read-only baseline lookup permission", async () => {
  for (const workflow of ["ci.yml", "nightly.yml", "release.yml"]) {
    const { jobs } = parse(await readWorkflow(workflow))
    for (const name of ["quality", "test"]) {
      assert.deepEqual(
        jobs[name].permissions,
        { contents: "read", actions: "read" },
        `${workflow}:${name}`
      )
    }
  }
})

test("Quality executes the frozen affected matrix and nightly retains the full registry", async () => {
  const quality = parse(await readWorkflow("quality.yml"))
  const steps = quality.jobs.prepare.steps
  const manifest = steps.find((step) => step.id === "manifest").run
  assert.match(manifest, /buildQualityPlan\(readChangePlan\('\.cache\/ci\/changes\.json'\)\)/)
  assert.match(manifest, /groups=\$\{JSON\.stringify\(plan\.include\)\}/)
  const publish = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))
  assert.equal(publish.with.name, "quality-change-plan")
  const execution = quality.jobs.gates.steps
  assert.equal(
    execution.find((step) => step.uses?.startsWith("actions/download-artifact@")).with.name,
    publish.with.name
  )
  assert.match(
    execution.find((step) => step.name === "Run gate group").run,
    /--change-plan \.cache\/ci\/changes\.json --group/
  )
  assert.equal(quality.on.workflow_dispatch.inputs["quality-mode"].default, "full")
  const nightly = parse(await readWorkflow("nightly.yml"))
  assert.equal(nightly.jobs.quality.with["quality-mode"], "full")
  assert.deepEqual(nightly.jobs["build-tauri"].needs, ["quality", "test"])
  const jestSteps = parse(await readWorkflow("test.yml")).jobs["jest-plan"].steps
  assert.match(
    jestSteps.find((step) => step.id === "plan").run,
    /--plan --change-plan \.cache\/ci\/changes\.json/
  )
})

test("the Pro IDE E2E runs on its own impact against the pinned code-server", async () => {
  const { jobs } = parse(await readWorkflow("test.yml"))
  const job = jobs["pro-ide-e2e"]
  assert.equal(job.needs, "jest-plan")
  assert.equal(job.if, "fromJSON(needs.jest-plan.outputs.impacts).proIde")
  const cache = job.steps.find((step) => step.name === "Cache pinned code-server")
  assert.equal(cache.with.path, "target/code-server")
  assert.match(cache.with.key, /hashFiles\('crates\/cognia-codeserver\/src\/download\.rs'\)/)
  const run = job.steps.find((step) => step.name === "Run the Pro IDE E2E and performance gates")
  assert.match(run.run, /scripts\/test\/run-pro-ide-e2e\.mjs --perf/)
  const upload = job.steps.find((step) => step.name === "Upload performance result")
  assert.equal(upload.if, "always()")
})

test("tagged releases attach a smoked host archive for every catalog archive target", async () => {
  const { HOST_TARGETS } = await import("../release/update-catalog.mjs")
  const { LINUX_GLIBC_BASELINE } = await import("../build/package-host-archive.mjs")
  const { jobs } = parse(await readWorkflow("release.yml"))
  const job = jobs["publish-host-archives"]
  assert.ok(job, "release.yml packages the host archives")
  assert.ok(job.needs.includes("build-tauri"), "archives attach to the release build-tauri created")
  assert.deepEqual(job.permissions, { contents: "write" })

  const include = job.strategy.matrix.include
  const archiveTargets = Object.keys(HOST_TARGETS).filter((t) => HOST_TARGETS[t] === "archive")
  assert.deepEqual(include.map((entry) => entry.target).sort(), archiveTargets.sort())
  for (const { runner, target } of include) {
    // The brain carries the build machine's native addons: no cross builds.
    const arm = /arm64$/.test(target)
    if (target.startsWith("linux-")) {
      // Built on the glibc floor the installer probes for (Ubuntu 22.04 = 2.35).
      assert.equal(LINUX_GLIBC_BASELINE, "2.35")
      assert.equal(runner, arm ? "ubuntu-22.04-arm" : "ubuntu-22.04", target)
    } else {
      assert.match(runner, arm ? /^macos-1\d$/ : /^macos-\d+-intel$/, target)
    }
  }

  const steps = job.steps
  const build = steps.findIndex((s) => s.name === "Build and package the host archive")
  const smoke = steps.findIndex((s) => s.name === "Smoke the unpacked archive")
  const attach = steps.findIndex((s) => s.name === "Attach the host archive to the release")
  const prepare = steps.findIndex((s) => s.run === "pnpm cli:release:prepare")
  assert.ok(prepare >= 0 && prepare < build && build < smoke && smoke < attach)
  assert.match(steps[build].run, /package-host-archive\.mjs/)
  assert.match(steps[build].run, /--notarize/)
  assert.match(steps[smoke].run, /\/readyz/)
  assert.match(steps[attach].run, /gh release upload/)
  assert.match(steps[attach].run, /\.tar\.gz\.sha256/)
})

test("Cargo-only image plans build workspace consumers without unrelated service and web images", async () => {
  const { jobs } = parse(await readWorkflow("images.yml"))
  assert.match(jobs.vars.outputs["cargo-only"], /steps\.plan\.outputs\.cargo-only/)
  const plan = jobs.vars.steps.find((step) => step.id === "plan")
  assert.match(plan.run, /isCargoDependencyChange/)
  assert.match(plan.env.PR_BASE_SHA, /pull_request\.base\.sha/)
  const matrix = jobs["fast-images"].strategy.matrix
  assert.equal(matrix.include, "${{ fromJSON(needs.vars.outputs.fast-images) }}")
  const workflow = parse(await readWorkflow("images.yml"))
  const images = JSON.parse(workflow.env.FAST_IMAGE_MATRIX)
  assert.deepEqual(
    images.map((image) => image.name),
    [
      "cognia-workspace-runtime",
      "cognia-collab",
      "cognia-deploy-agent",
      "cognia-ops-controller",
      "cognia-docker-proxy",
      "cognia-web",
    ]
  )
  for (const image of images) {
    await readFile(new URL(`../../${image.file}`, import.meta.url))
  }
  assert.deepEqual(
    images.filter((image) => image.rootCargo).map((image) => image.name),
    ["cognia-collab", "cognia-deploy-agent", "cognia-ops-controller", "cognia-docker-proxy"]
  )
  assert.match(plan.run, /images\.filter\(image => image\.rootCargo === true\)/)
  const bundle = jobs["agent-bundle"].steps
  assert.match(bundle.find((step) => step.id === "build").with.target, /sandboxd/)
  assert.match(bundle.find((step) => step.name === "Smoke against user images").if, /cargo-only/)
  assert.equal(jobs["cognia-server-check"].if, "github.event_name == 'pull_request'")
})

test("Dependabot batches the shared Cargo lock and keeps incompatible type families aligned", async () => {
  const config = parse(
    await readFile(new URL("../../.github/dependabot.yml", import.meta.url), "utf8")
  )
  const cargo = config.updates.find((update) => update["package-ecosystem"] === "cargo")
  assert.equal(cargo["open-pull-requests-limit"], 1)
  assert.deepEqual(Object.keys(cargo.groups), ["cargo-dependencies"])
  assert.deepEqual(cargo.groups["cargo-dependencies"].patterns, ["*"])
  assert.ok(
    cargo.ignore.some(
      (rule) => rule["dependency-name"] === "windows-future" && rule.versions.includes("0.100")
    )
  )
  assert.ok(
    cargo.ignore.some(
      (rule) => rule["dependency-name"] === "rten-imageproc" && rule.versions.includes("0.27")
    )
  )
  const actions = config.updates.find((update) => update["package-ecosystem"] === "github-actions")
  assert.equal(actions.groups["github-actions"]["update-types"], undefined)
})

test("image planning executes against exact Git trees and preserves full publication", async () => {
  const workflow = parse(await readWorkflow("images.yml"))
  const step = workflow.jobs.vars.steps.find((step) => step.id === "plan")
  const script = step.run.split("<<'NODE'\n")[1].replace(/\nNODE\s*$/, "")
  const directory = await mkdtemp(join(tmpdir(), "cognia-image-plan-"))
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim()
  try {
    await symlink(fileURLToPath(new URL("../", import.meta.url)), join(directory, "scripts"))
    git("init", "--quiet")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "user.name", "Image fixture")
    git("remote", "add", "origin", directory)
    await writeFile(join(directory, "Cargo.lock"), "old")
    git("add", "Cargo.lock")
    git("commit", "--quiet", "-m", "base")
    const base = git("rev-parse", "HEAD")
    await writeFile(join(directory, "Cargo.lock"), "new")
    git("add", "Cargo.lock")
    git("commit", "--quiet", "-m", "dependency batch")
    const head = git("rev-parse", "HEAD")
    const output = join(directory, "output")
    const summary = join(directory, "summary")
    const run = async (event, prBase = base) => {
      await writeFile(output, "")
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: directory,
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          FAST_IMAGE_MATRIX: workflow.env.FAST_IMAGE_MATRIX,
          EVENT_NAME: event,
          PR_BASE_SHA: prBase,
          GITHUB_SHA: head,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
      })
      return Object.fromEntries(
        (await readFile(output, "utf8"))
          .trim()
          .split("\n")
          .map((line) => {
            const index = line.indexOf("=")
            return [line.slice(0, index), line.slice(index + 1)]
          })
      )
    }
    const cargo = await run("pull_request")
    assert.equal(cargo["cargo-only"], "true")
    assert.deepEqual(
      JSON.parse(cargo["fast-images"]).map((image) => image.name),
      ["cognia-collab", "cognia-deploy-agent", "cognia-ops-controller", "cognia-docker-proxy"]
    )
    for (const [event, prBase] of [
      ["workflow_dispatch", base],
      ["push", base],
      ["pull_request", "f".repeat(40)],
    ]) {
      const full = await run(event, prBase)
      assert.equal(full["cargo-only"], "false")
      assert.deepEqual(JSON.parse(full["fast-images"]), JSON.parse(workflow.env.FAST_IMAGE_MATRIX))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
