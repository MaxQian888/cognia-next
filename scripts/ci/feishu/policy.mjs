import { createHash } from "node:crypto"

// File identities are stable even when display names change. The workflow
// contract test checks this registry against every workflow trigger.
export const WORKFLOWS = {
  "ci.yml": "ci",
  "quality.yml": "ci",
  "test.yml": "ci",
  "report.yml": "ci",
  "bootstrap-scripts.yml": "ci",
  "nightly.yml": "ci",
  "compose-e2e.yml": "ci",
  "share-server.yml": "ci",
  "signaling-server.yml": "ci",
  "release.yml": "release",
  "build-tauri.yml": "release",
  "images.yml": "release",
  "deploy.yml": "ops",
  "refresh-website.yml": "ops",
  "sync-model-catalog.yml": "ops",
}
const BAD = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"])
export const isFailure = (status) => BAD.has(status)
export const workflowFile = (run) =>
  String(run.path ?? "")
    .split("@")[0]
    .split("/")
    .at(-1)

export function normalizeRun(run, jobs) {
  const file = workflowFile(run)
  if (!Object.hasOwn(WORKFLOWS, file)) throw new Error("unsupported-workflow")
  if (
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  ) {
    throw new Error("invalid-source-identity")
  }
  const deployment = file === "deploy.yml" || file === "refresh-website.yml"
  const targets = jobs.filter((job) => /(?:Worker —|Fly —|Pages —)/u.test(job.name))
  const failed = jobs.filter((job) => isFailure(job.conclusion))
  let status = run.conclusion ?? "unknown"
  if (status === "success" && failed.length) status = "failure"
  if (deployment && status === "success") {
    if (targets.length === 0) status = "deployment-unverified"
    else if (targets.every((job) => job.conclusion === "skipped")) status = "not-deployed"
    else if (targets.some((job) => !["success", "skipped"].includes(job.conclusion)))
      status = "deployment-unverified"
  }
  const signature = createHash("sha256")
    .update(
      JSON.stringify(
        failed.map((job) => [job.name, job.conclusion]).sort((a, b) => a[0].localeCompare(b[0]))
      )
    )
    .digest("hex")
  return {
    ...run,
    file,
    route: WORKFLOWS[file],
    status,
    failed,
    targets,
    jobs,
    fingerprint: `${status}:${signature}`,
  }
}

export function sameScope(a, b) {
  return (
    a.workflow_id === b.workflow_id &&
    a.head_branch === b.head_branch &&
    a.event === b.event &&
    a.head_repository?.full_name === b.head_repository?.full_name
  )
}

export function decide(source, { mode = "changes", previous, previousAccepted = false } = {}) {
  if (!["changes", "failures", "all"].includes(mode)) throw new Error("invalid-notification-mode")
  if (source.status === "not-deployed") return { send: mode === "all", reason: "not-deployed" }
  if (mode === "all") return { send: true, reason: "all-results" }
  if (["cancelled", "skipped", "neutral"].includes(source.status))
    return { send: false, reason: "non-actionable" }
  if (isFailure(source.status) || ["unknown", "deployment-unverified"].includes(source.status)) {
    const repeat =
      mode === "changes" && previous?.fingerprint === source.fingerprint && previousAccepted
    return { send: !repeat, reason: repeat ? "unchanged-failure" : "failure" }
  }
  if (mode === "failures") return { send: false, reason: "success-filtered" }
  if (previous && isFailure(previous.status)) return { send: true, reason: "recovered" }
  // A completed parent release is the authority, never a nested build job.
  if (
    source.file === "release.yml" ||
    source.file === "deploy.yml" ||
    (source.file === "images.yml" && source.event !== "pull_request")
  ) {
    return { send: true, reason: "delivery-completed" }
  }
  return { send: false, reason: "routine-success" }
}

export function selectDestination(route, env) {
  const prefix = `FEISHU_${route.toUpperCase()}`
  const override = env[`${prefix}_WEBHOOK_URL`] || env[`${prefix}_SIGNING_SECRET`]
  const url = override ? env[`${prefix}_WEBHOOK_URL`] : env.FEISHU_WEBHOOK_URL
  const secret = override ? env[`${prefix}_SIGNING_SECRET`] : env.FEISHU_SIGNING_SECRET
  if ((url && !secret) || (secret && !url)) throw new Error("incomplete-webhook-signing-pair")
  return { url: url ?? "", secret: secret ?? "" }
}

export function stateKey(source, destination) {
  const identity = [
    source.repository.full_name,
    source.id,
    source.run_attempt,
    source.route,
    destination,
  ]
  return `feishu-v1-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`
}
