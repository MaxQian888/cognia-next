#!/usr/bin/env node
/**
 * Gate: the server image declares what external-agent hosting actually needs.
 *
 * Why it exists: two preconditions were enforced at runtime and satisfied
 * nowhere, so both failed only on a real host, long after the build was green.
 *
 *   1. `cognia-external-agent-launcher` refuses to spawn without `bwrap` on
 *      the PATH, and `SandboxError` has no "continue unsandboxed" variant —
 *      yet no image installed bubblewrap. Every external agent in the
 *      container failed with "bubblewrap (bwrap) is required". The compose
 *      seccomp profile had already been tuned to let bwrap unshare user
 *      namespaces, which is how invisible the gap was: the accommodation
 *      shipped and the binary did not.
 *   2. `verifyPiExtension` refuses a Pi session when the bundled extension is
 *      absent (absent means Pi's native tools would run unintercepted, so it
 *      is a refusal, not a downgrade) — yet the pkg/Node layout that becomes
 *      the brain never staged it. Pi could not start in the container at all.
 *
 * Both are static facts about the Dockerfile and the build scripts, which is
 * why they are checkable here rather than only in a container smoke test.
 *
 * What is checked:
 *   1. the runtime stage installs bubblewrap;
 *   2. it runs as the non-root runtime uid;
 *   3. `NODE_ENV=production` is set, which is what disables the
 *      `$COGNIA_PI_EXTENSION_PATH` override in a shipped image;
 *   4. every runtime directory named by an env var is created and owned by the
 *      runtime uid before `VOLUME`, so a fresh volume is seeded with it;
 *   5. every build script that assembles a CLI/brain layout stages the Pi
 *      extension through the shared helper.
 *
 * What is NOT checked, and why: that the image actually boots, that bwrap can
 * unshare a user namespace under the host's seccomp/AppArmor policy, or that
 * Pi's credentials survive a container recreation. Those are runtime
 * properties of a built image on a specific host; a static gate claiming them
 * would read as coverage it does not have. They belong to the container smoke
 * test.
 *
 * Usage: pnpm audit:agent-host-image
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

export const DOCKERFILE = "Dockerfile.cognia-server"

/** The uid/gid the runtime stages create and run as. */
export const RUNTIME_UID = "10001"

/**
 * Env vars that name a directory the runtime writes to. Each must also be
 * created and chowned in the same stage — a variable pointing at a path that
 * does not exist fails at the first spawn, not at build time.
 */
export const RUNTIME_DIR_ENVS = ["COGNIA_DATA_DIR", "COGNIA_WORKSPACES_DIR", "PI_CODING_AGENT_DIR"]

/** Build scripts that assemble a layout the Pi extension has to reach. */
export const LAYOUT_BUILD_SCRIPTS = [
  "scripts/build/build-cli.mjs",
  "scripts/build/build-cli-bun.mjs",
  "scripts/build/build-cli-binary.mjs",
]

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8")

/**
 * The text of the named Dockerfile stage: from its `FROM ... AS <name>` line
 * to the next `FROM`, plus every stage it inherits from (so a check passes
 * when the requirement is satisfied by a base stage).
 */
export function stageText(dockerfile, stage) {
  const stages = new Map()
  let current = null
  for (const line of dockerfile.split("\n")) {
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i)
    if (from) {
      current = { base: from[1], lines: [] }
      stages.set(from[2] ?? from[1], current)
      continue
    }
    current?.lines.push(line)
  }

  const seen = new Set()
  const collect = (name) => {
    if (!name || seen.has(name) || !stages.has(name)) return ""
    seen.add(name)
    const entry = stages.get(name)
    return `${collect(entry.base)}\n${entry.lines.join("\n")}`
  }
  return collect(stage)
}

/**
 * Every `ENV NAME=VALUE` assignment visible in `text`, including line
 * continuations.
 *
 * Last-wins, because that is what Docker does — and because `stageText`
 * concatenates an inherited base stage's lines BEFORE the current stage's, so
 * first-wins would report a base's value for a name the runtime stage
 * overrides. That is the wrong answer in both directions: it can fail a
 * correct Dockerfile, and it can pass one whose later `ENV` re-enables the
 * `$COGNIA_PI_EXTENSION_PATH` override this gate exists to keep off.
 */
export function envAssignments(text) {
  const assignments = new Map()
  // `ENV A=1 \` + continuation lines: join first so a continued block is one string.
  const joined = text.replace(/\\\r?\n\s*/g, " ")
  for (const line of joined.split("\n")) {
    if (!/^\s*ENV\s/i.test(line)) continue
    for (const [, name, value] of line.matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/g)) {
      assignments.set(name, value)
    }
  }
  return assignments
}

export function checkRuntimeStage(dockerfile, stage = "runtime-slim") {
  const problems = []
  const text = stageText(dockerfile, stage)
  if (!text.trim()) return [`${DOCKERFILE}: no stage named "${stage}"`]

  if (!/apt-get install[\s\S]*?\bbubblewrap\b/.test(text)) {
    problems.push(
      `${DOCKERFILE} (${stage}): bubblewrap is not installed. cognia-external-agent-launcher refuses every spawn without \`bwrap\`, and there is no unsandboxed fallback.`
    )
  }

  if (!new RegExp(`^\\s*USER\\s+${RUNTIME_UID}(:|\\s|$)`, "m").test(text)) {
    problems.push(`${DOCKERFILE} (${stage}): does not run as uid ${RUNTIME_UID}.`)
  }

  const env = envAssignments(text)
  if (env.get("NODE_ENV") !== "production") {
    problems.push(
      `${DOCKERFILE} (${stage}): NODE_ENV must be "production" — it is what disables $COGNIA_PI_EXTENSION_PATH, the override that would otherwise swap out the component holding Pi's permission gate.`
    )
  }

  for (const name of RUNTIME_DIR_ENVS) {
    const dir = env.get(name)
    if (!dir) {
      problems.push(`${DOCKERFILE} (${stage}): ${name} is not set.`)
      continue
    }
    if (!new RegExp(`mkdir[^\\n]*\\s${dir}(\\s|$)`, "m").test(text)) {
      problems.push(
        `${DOCKERFILE} (${stage}): ${name}=${dir} is never created. A runtime directory that does not exist fails at the first spawn, not at build time.`
      )
    }
  }

  if (!/chown\s+-R\s+cognia:cognia/.test(text)) {
    problems.push(
      `${DOCKERFILE} (${stage}): runtime directories are not chowned to the runtime user.`
    )
  }

  return problems
}

export function checkLayoutBuilds(sources) {
  const problems = []
  for (const [rel, source] of Object.entries(sources)) {
    if (!/stagePiExtension\s*\(/.test(source)) {
      problems.push(
        `${rel}: does not stage the Pi extension through stagePiExtension(). Hand-rolled copies are how the pkg layout came to ship none at all while the Bun layout shipped an unverified one; the shared helper is the only path that both places the files where the resolver looks and checks the pin.`
      )
    }
  }
  return problems
}

export function runChecks({ dockerfile, sources }) {
  return [...checkRuntimeStage(dockerfile), ...checkLayoutBuilds(sources)]
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (invokedDirectly) {
  const sources = Object.fromEntries(LAYOUT_BUILD_SCRIPTS.map((rel) => [rel, read(rel)]))
  const problems = runChecks({ dockerfile: read(DOCKERFILE), sources })
  if (problems.length > 0) {
    console.error("agent-host-image: the server image does not satisfy external-agent hosting\n")
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    console.error(`\n${problems.length} problem(s).`)
    process.exit(1)
  }
  console.log(
    `agent-host-image: OK — bubblewrap, uid ${RUNTIME_UID}, NODE_ENV=production, ${RUNTIME_DIR_ENVS.length} runtime dirs, ${LAYOUT_BUILD_SCRIPTS.length} layout builds stage the Pi extension.`
  )
}
