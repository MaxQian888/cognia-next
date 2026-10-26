#!/usr/bin/env node
/** Shared Git-only planning for Jest and Quality, before dependency installation. */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const SHA = /^[a-f0-9]{40}$/
const isSha = (value) => typeof value === "string" && SHA.test(value)
const gitExec = (command, args, cwd = process.cwd()) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })

/** Only the root Cargo graph is narrowed; mixed, deleted and full plans retain every check. */
export function isCargoDependencyChange(plan) {
  return (
    plan.mode === "incremental" &&
    plan.deletedFiles.length === 0 &&
    plan.changedFiles.length > 0 &&
    plan.changedFiles.every((file) =>
      /^(?:Cargo\.(?:toml|lock)|(?:crates\/[^/]+|src-tauri)\/Cargo\.toml)$/.test(file)
    )
  )
}

/** Endpoint diffs need trees, not ancestry. Local branch comparison retains merge-base semantics. */
export function listCommittedChanges(base, head, exec = gitExec, comparison = "merge-base") {
  if (!["endpoints", "merge-base"].includes(comparison)) throw new Error("Unknown Git comparison")
  const resolve = (ref) =>
    exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim()
  const resolvedBase = resolve(base)
  const resolvedHead = resolve(head)
  const mergeBase =
    comparison === "merge-base"
      ? exec("git", ["merge-base", resolvedBase, resolvedHead]).trim()
      : null
  const diffBase = mergeBase ?? resolvedBase
  const records = exec("git", [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    diffBase,
    resolvedHead,
    "--",
  ]).split("\0")
  const changedFiles = [],
    deletedFiles = []
  for (let index = 0; index < records.length - 1; index += 2) {
    const status = records[index],
      file = records[index + 1]
    if (!file || !/^[ACDMTUXB]$/.test(status)) throw new Error("Malformed Git name-status record")
    changedFiles.push(file)
    if (status === "D") deletedFiles.push(file)
  }
  if (records.at(-1) !== "" || records.length % 2 !== 1)
    throw new Error("Incomplete Git name-status output")
  return {
    base: resolvedBase,
    head: resolvedHead,
    mergeBase,
    diffBase,
    comparison,
    changedFiles: [...new Set(changedFiles)].sort(),
    deletedFiles: deletedFiles.sort(),
  }
}

export function validateChangePlan(plan) {
  if (
    !plan ||
    plan.version !== 1 ||
    !["incremental", "full"].includes(plan.mode) ||
    !isSha(plan.head) ||
    !isSha(plan.base) ||
    !isSha(plan.diffBase) ||
    !["endpoints", "merge-base"].includes(plan.comparison) ||
    !(plan.mergeBase === null || isSha(plan.mergeBase)) ||
    typeof plan.reason !== "string" ||
    !plan.reason ||
    !Array.isArray(plan.changedFiles) ||
    !Array.isArray(plan.deletedFiles)
  ) {
    throw new Error("Invalid change plan")
  }
  for (const files of [plan.changedFiles, plan.deletedFiles]) {
    if (
      new Set(files).size !== files.length ||
      files.some(
        (file) =>
          typeof file !== "string" ||
          !file ||
          file.includes("\0") ||
          path.posix.isAbsolute(file) ||
          file.split("/").some((part) => part === ".." || part === "." || !part)
      )
    ) {
      throw new Error("Invalid change plan paths")
    }
  }
  if (
    plan.deletedFiles.some((file) => !plan.changedFiles.includes(file)) ||
    plan.diffBase !== (plan.comparison === "endpoints" ? plan.base : plan.mergeBase) ||
    (plan.comparison === "endpoints" && plan.mergeBase !== null)
  ) {
    throw new Error("Inconsistent change plan")
  }
  return plan
}

export function readChangePlan(file, { cwd = process.cwd() } = {}) {
  const plan = validateChangePlan(JSON.parse(readFileSync(file, "utf8")))
  const head = gitExec("git", ["rev-parse", "HEAD"], cwd).trim()
  if (plan.head !== head) throw new Error("Change plan does not match the checked-out HEAD")
  return plan
}

/** Real CI compares the tested integration tree to the event's exact base tree. */
export function createChangePlan(
  {
    requestedMode = "auto",
    eventName,
    ref = "",
    head,
    prBaseSha = "",
    pushBeforeSha = "",
    pushForced = false,
    baselineValidated = true,
  },
  { cwd = process.cwd() } = {}
) {
  if (!["auto", "incremental", "full"].includes(requestedMode))
    throw new Error("Invalid requested mode")
  if (!isSha(head)) throw new Error("Invalid head SHA")
  const exec = (command, args) => gitExec(command, args, cwd)
  if (exec("git", ["rev-parse", "HEAD"]).trim() !== head)
    throw new Error("Requested head is not checked out")
  const full = (reason) =>
    validateChangePlan({
      version: 1,
      mode: "full",
      reason,
      ...listCommittedChanges(head, head, exec, "endpoints"),
    })
  const mode =
    requestedMode === "auto"
      ? eventName === "pull_request" || (eventName === "push" && ref.startsWith("refs/heads/"))
        ? "incremental"
        : "full"
      : requestedMode
  if (mode === "full") return full("full-mode")
  if (eventName === "push" && pushForced) return full("force-push")
  if (eventName === "push" && !baselineValidated) return full("unverified-push-baseline")
  let base
  if (eventName === "pull_request") base = prBaseSha
  else if (eventName === "push") base = pushBeforeSha
  else {
    try {
      base = exec("git", ["rev-parse", "--verify", "HEAD^"]).trim()
    } catch {
      return full("missing-parent")
    }
  }
  if (!isSha(base) || /^0+$/.test(base)) return full("missing-event-base")
  try {
    // Fetch even when the object exists: it must come from this event's origin.
    exec("git", ["fetch", "--no-tags", "--depth=1", "origin", base])
  } catch {
    return full("unfetchable-event-base")
  }
  // Diff failures are not empty selections. A complete plan is safe if both
  // endpoints exist but Git cannot enumerate their delta.
  try {
    const plan = validateChangePlan({
      version: 1,
      mode: "incremental",
      reason: "event-tree-diff",
      ...listCommittedChanges(base, head, exec, "endpoints"),
    })
    if (
      plan.changedFiles.some((file) =>
        /^(?:scripts\/(?:ci\/change-plan|test\/coverage-changed|gates\/check-all)\.mjs|\.github\/workflows\/(?:ci|test|quality)\.yml)$/.test(
          file
        )
      )
    ) {
      return { ...plan, mode: "full", reason: "selection-policy-changed" }
    }
    return plan
  } catch {
    return full("unreadable-event-diff")
  }
}

/** A failed/cancelled predecessor must not disappear from the next push's scope. */
export async function isPushBaselineValidated(env, request = fetch) {
  if (env.EVENT_NAME !== "push" || !env.GITHUB_REF?.startsWith("refs/heads/")) return true
  if (env.PUSH_FORCED === "true") return false
  if (!SHA.test(env.PUSH_BEFORE_SHA ?? "") || /^0+$/.test(env.PUSH_BEFORE_SHA)) return false
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return false
  const params = new URLSearchParams({
    head_sha: env.PUSH_BEFORE_SHA,
    event: "push",
    branch: env.GITHUB_REF.slice(11),
    per_page: "100",
  })
  try {
    const response = await request(
      `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?${params}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(15000),
      }
    )
    if (!response.ok) return false
    const data = await response.json()
    return (
      Array.isArray(data.workflow_runs) &&
      data.workflow_runs.some(
        (run) =>
          run.head_sha === env.PUSH_BEFORE_SHA &&
          run.event === "push" &&
          run.head_branch === env.GITHUB_REF.slice(11) &&
          run.conclusion === "success"
      )
    )
  } catch {
    return false
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: { output: { type: "string" } },
    strict: true,
  })
  if (!values.output) throw new Error("--output is required")
  const baselineValidated =
    env.REQUESTED_MODE === "full" ? true : await isPushBaselineValidated(env)
  const plan = createChangePlan({
    requestedMode: env.REQUESTED_MODE || "auto",
    eventName: env.EVENT_NAME,
    ref: env.GITHUB_REF,
    head: env.GITHUB_SHA,
    prBaseSha: env.PR_BASE_SHA,
    pushBeforeSha: env.PUSH_BEFORE_SHA,
    pushForced: env.PUSH_FORCED === "true",
    baselineValidated,
  })
  mkdirSync(path.dirname(values.output), { recursive: true })
  writeFileSync(values.output, `${JSON.stringify(plan, null, 2)}\n`)
  process.stdout.write(
    `Change plan: ${plan.mode} (${plan.reason}), ${plan.changedFiles.length} paths\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`[change-plan] ${error.message}\n`)
    process.exitCode = 1
  })
}
