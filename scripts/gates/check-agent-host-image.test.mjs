import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

import {
  LAYOUT_BUILD_SCRIPTS,
  RUNTIME_DIR_ENVS,
  checkLayoutBuilds,
  checkRuntimeStage,
  envAssignments,
  runChecks,
  stageText,
} from "./check-agent-host-image.mjs"

const GOOD_DOCKERFILE = `
FROM node:26-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates bubblewrap
RUN groupadd --system --gid 10001 cognia \\
    && mkdir -p /data /data/workspaces /data/pi-home/.pi/agent \\
    && chown -R cognia:cognia /data
FROM base AS runtime-slim
ENV NODE_ENV=production \\
    COGNIA_DATA_DIR=/data \\
    COGNIA_WORKSPACES_DIR=/data/workspaces \\
    PI_CODING_AGENT_DIR=/data/pi-home/.pi/agent
USER 10001:10001
`

const GOOD_SOURCES = Object.fromEntries(
  LAYOUT_BUILD_SCRIPTS.map((rel) => [rel, "stagePiExtension({ root, sidecarOutDir })"])
)

test("passes a stage that satisfies every requirement", () => {
  assert.deepEqual(runChecks({ dockerfile: GOOD_DOCKERFILE, sources: GOOD_SOURCES }), [])
})

// The requirement may be met by a base stage — runtime-full inherits the apt
// set and the uid from runtime-slim, and a check that ignored inheritance
// would demand duplicated lines.
test("stageText includes inherited base stages", () => {
  const text = stageText(GOOD_DOCKERFILE, "runtime-slim")
  assert.match(text, /bubblewrap/)
  assert.match(text, /groupadd/)
})

test("envAssignments reads across line continuations", () => {
  const env = envAssignments(GOOD_DOCKERFILE)
  assert.equal(env.get("NODE_ENV"), "production")
  assert.equal(env.get("COGNIA_WORKSPACES_DIR"), "/data/workspaces")
  assert.equal(env.get("PI_CODING_AGENT_DIR"), "/data/pi-home/.pi/agent")
})

// Docker's ENV is last-wins, and `stageText` puts an inherited base stage's
// lines first — so first-wins would report a base's value for a name the
// runtime stage overrides, and a later re-enable of the Pi extension override
// would read as absent.
test("envAssignments is last-wins, like Docker", () => {
  const env = envAssignments(
    ["ENV NODE_ENV=development", "RUN true", "ENV NODE_ENV=production"].join("\n")
  )
  assert.equal(env.get("NODE_ENV"), "production")
})

test("flags a missing stage rather than passing vacuously", () => {
  const problems = checkRuntimeStage(GOOD_DOCKERFILE, "no-such-stage")
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no stage named/)
})

test("flags a runtime stage without bubblewrap", () => {
  const without = GOOD_DOCKERFILE.replace(" bubblewrap", "")
  assert.match(checkRuntimeStage(without).join("\n"), /bubblewrap is not installed/)
})

test("flags a runtime stage that does not drop to the runtime uid", () => {
  const asRoot = GOOD_DOCKERFILE.replace("USER 10001:10001", "USER root")
  assert.match(checkRuntimeStage(asRoot).join("\n"), /does not run as uid 10001/)
})

test("flags NODE_ENV that is unset or not production", () => {
  const unset = GOOD_DOCKERFILE.replace("NODE_ENV=production \\\n    ", "")
  assert.match(checkRuntimeStage(unset).join("\n"), /NODE_ENV must be "production"/)
  const dev = GOOD_DOCKERFILE.replace("NODE_ENV=production", "NODE_ENV=development")
  assert.match(checkRuntimeStage(dev).join("\n"), /NODE_ENV must be "production"/)
})

test("flags a runtime dir env that is set but never created", () => {
  const uncreated = GOOD_DOCKERFILE.replace(" /data/workspaces /data/pi-home/.pi/agent", "")
  const problems = checkRuntimeStage(uncreated).join("\n")
  assert.match(problems, /COGNIA_WORKSPACES_DIR=\/data\/workspaces is never created/)
  assert.match(problems, /PI_CODING_AGENT_DIR=.* is never created/)
})

test("flags each runtime dir env that is not set at all", () => {
  for (const name of RUNTIME_DIR_ENVS) {
    const without = GOOD_DOCKERFILE.replace(new RegExp(`\\s*${name}=\\S+`), "")
    assert.match(checkRuntimeStage(without).join("\n"), new RegExp(`${name} is not set`))
  }
})

test("flags a layout build that stages the Pi extension by hand", () => {
  const byHand = { "scripts/build/build-cli.mjs": 'fs.copyFileSync(src, "sidecar/pi-extension/x")' }
  assert.match(checkLayoutBuilds(byHand).join("\n"), /stagePiExtension\(\)/)
})

// A gate that only passes proves nothing. Every check above is exercised
// through `checkRuntimeStage` / `checkLayoutBuilds` directly, so `runChecks`
// itself had nothing but a passing-path test: dropping either call from its
// body would leave the whole suite green while the gate stopped catching the
// two defects it was written for. Reconstruct exactly those defects here.
test("runChecks reports the two shipped defects it was written to catch", () => {
  const noBubblewrap = GOOD_DOCKERFILE.replace(" bubblewrap", "")
  const stagedByHand = Object.fromEntries(
    LAYOUT_BUILD_SCRIPTS.map((rel) => [rel, 'fs.copyFileSync(src, "sidecar/pi-extension/x")'])
  )
  const problems = runChecks({ dockerfile: noBubblewrap, sources: stagedByHand }).join("\n")

  assert.match(problems, /bubblewrap is not installed/)
  assert.match(problems, /stagePiExtension\(\)/)
})

test("headless Rust stages omit desktop bundle staging and retain the real brain layout", () => {
  const dockerfile = readFileSync(
    new URL("../../Dockerfile.cognia-server", import.meta.url),
    "utf8"
  )
  for (const stage of ["builder", "check"]) {
    const source = stageText(dockerfile, stage)
    const config = source.match(/^ENV TAURI_CONFIG='([^']+)'$/m)
    assert.ok(config, `${stage} must explicitly disable desktop-only resource staging`)
    assert.deepEqual(JSON.parse(config[1]).bundle, { resources: [], externalBin: [] })
    assert.doesNotMatch(source, /COPY sidecar\//)
    assert.doesNotMatch(source, /echo placeholder/)
  }
  const runtime = stageText(dockerfile, "runtime-slim")
  assert.match(
    runtime,
    /COPY --from=brain-builder \/work\/cli\/dist\/bin\/cognia-agent-layout \/app\/brain/
  )
  assert.match(runtime, /COGNIA_SIDECAR_SCRIPT=\/app\/brain\/sidecar\/claude-host\.mjs/)
})

test("all literal server Docker COPY inputs exist in a fresh checkout", () => {
  const dockerfile = readFileSync(
    new URL("../../Dockerfile.cognia-server", import.meta.url),
    "utf8"
  )
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    cwd: new URL("../../", import.meta.url),
  }).split("\0")
  for (const line of dockerfile.split("\n")) {
    if (!line.startsWith("COPY ") || line.includes("--from=")) continue
    for (const input of line.split(/\s+/).slice(1, -1)) {
      if (input === ".") continue
      assert.ok(
        tracked.some((file) => file === input || file.startsWith(`${input}/`)),
        `${input} is not tracked`
      )
    }
  }
})

test("server dependency cooking has the same capture linker prerequisite as final builds", () => {
  const dockerfile = readFileSync(
    new URL("../../Dockerfile.cognia-server", import.meta.url),
    "utf8"
  )
  const chef = dockerfile.split("FROM chef AS planner")[0]
  assert.match(chef, /\blibgbm-dev\b/)
  assert.match(dockerfile, /\blibgbm1\b/)
})

test("both server compile stages carry Rust out-of-tree embedded inputs", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url))
  const dockerfile = readFileSync(
    new URL("../../Dockerfile.cognia-server", import.meta.url),
    "utf8"
  )
  const rustFiles = execFileSync("git", ["ls-files", "-z", "crates", "src-tauri"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file.endsWith(".rs"))
  const embedded = new Set()
  for (const file of rustFiles) {
    const source = readFileSync(resolve(root, file), "utf8")
    for (const match of source.matchAll(/include_(?:str|bytes)!\s*\(\s*"([^"]+)"/g)) {
      const target = relative(root, resolve(root, dirname(file), match[1]))
      if (!target.startsWith("crates/") && !target.startsWith("src-tauri/")) embedded.add(target)
    }
  }
  // The canonical JSON parity fixture resolves from Cargo's crate root.
  const canonical = readFileSync(resolve(root, "crates/cognia-canonical-json/src/lib.rs"), "utf8")
  const manifestRelative = canonical.match(
    /include_str!\(concat!\(\s*env!\("CARGO_MANIFEST_DIR"\),\s*"([^"]+)"/
  )
  assert.ok(manifestRelative)
  embedded.add(
    relative(root, resolve(root, "crates/cognia-canonical-json", `.${manifestRelative[1]}`))
  )
  assert.ok(embedded.has("protocol/external-agent-runtimes.json"))
  for (const stage of ["builder", "check"]) {
    const copies = stageText(dockerfile, stage)
      .split("\n")
      .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
      .flatMap((line) => line.split(/\s+/).slice(1, -1))
    for (const target of embedded) {
      assert.ok(
        copies.some((input) => target === input || target.startsWith(`${input}/`)),
        `${stage} is missing embedded input ${target}`
      )
    }
  }
})

for (const [file, stage] of [
  ["Dockerfile.cognia-server", "brain-builder"],
  ["deploy/compose/Dockerfile.web", "web-build"],
]) {
  test(`${file} exports a source-independent pnpm fetch layer before frozen offline linking`, () => {
    const source = stageText(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"), stage)
    const fetchAt = source.indexOf("RUN pnpm fetch --frozen-lockfile")
    const installAt = source.indexOf("RUN pnpm install --frozen-lockfile --offline")
    assert.ok(fetchAt >= 0 && installAt > fetchAt)
    const fetchInputs = source.slice(0, fetchAt)
    assert.match(fetchInputs, /^COPY pnpm-lock\.yaml pnpm-workspace\.yaml \.\/$/m)
    assert.match(fetchInputs, /^COPY patches \.\/patches$/m)
    assert.doesNotMatch(fetchInputs, /^COPY (?:package\.json|packages|scripts|\.) /m)
    assert.doesNotMatch(fetchInputs, /--mount=type=cache/)
    assert.ok(fetchInputs.includes('pnpm config set registry "${registry}"'))
    const linkingInputs = source.slice(fetchAt, installAt)
    for (const input of [
      "package.json",
      "packages",
      "docs/package.json",
      "mobile/package.json",
      "scripts/postinstall.mjs",
    ]) {
      assert.ok(
        linkingInputs.includes(`COPY ${input} `),
        `${input} must be available for linking/lifecycle scripts`
      )
    }
    assert.doesNotMatch(
      source.slice(fetchAt, installAt + "RUN pnpm install --frozen-lockfile --offline".length),
      /--ignore-scripts|--mount=type=cache/
    )
    assert.ok(source.indexOf("COPY . .", installAt) > installAt)
  })
}

test("the root Docker context excludes local caches without swallowing source fixtures", () => {
  const rules = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8").split("\n")
  assert.ok(rules.includes(".cache"))
  assert.ok(!rules.includes("**/out"))
  const tracked = execFileSync("git", ["ls-files", "--", ".cache"], {
    cwd: new URL("../../", import.meta.url),
    encoding: "utf8",
  })
  assert.equal(tracked, "")
})
