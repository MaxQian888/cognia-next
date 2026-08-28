import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

import {
  DOCKERFILE,
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

// A gate that only passes proves nothing. Run it against the commit before the
// fix and assert it reports the two shipped defects: no bubblewrap in the
// image, and layouts that staged the extension without the shared helper.
test("fails against the tree as it stood before the fix", () => {
  const at = (p) => execFileSync("git", ["show", `HEAD:${p}`], { encoding: "utf8" })
  let dockerfile
  try {
    dockerfile = at(DOCKERFILE)
  } catch {
    return // not a git checkout (or the file is new) — nothing to compare against
  }
  const sources = Object.fromEntries(LAYOUT_BUILD_SCRIPTS.map((rel) => [rel, at(rel)]))
  const problems = runChecks({ dockerfile, sources }).join("\n")
  assert.match(problems, /bubblewrap is not installed/)
  assert.match(problems, /stagePiExtension\(\)/)
})
