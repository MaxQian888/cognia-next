import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createGitHubClient } from "./github.mjs"
import {
  decide,
  isFailure,
  normalizeRun,
  sameScope,
  selectDestination,
  stateKey,
  WORKFLOWS,
  workflowFile,
} from "./policy.mjs"
import { getCurrentClaim, inspectDelivery, receiptName } from "./ledger.mjs"
import { renderCard, sendWebhook } from "./transport.mjs"
import { assemble } from "../report/build-report.mjs"
import { renderPreview } from "./preview.mjs"

const DAY = 86_400_000
const truth = (value) => value === "true"
const integer = (value) => {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
    throw new Error("invalid-run-id")
  return Number(value)
}

function context(env) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) throw new Error("invalid-repository")
  if (!env.FEISHU_OUTPUT_DIR) throw new Error("missing-output-directory")
  const dir = resolve(env.FEISHU_OUTPUT_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return { dir, repository: env.GITHUB_REPOSITORY }
}
function save(dir, name, value) {
  writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}
function output(env, values) {
  if (env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(values))
      appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
}
function finish(env, dir, result) {
  save(dir, "diagnostic.json", result)
  output(env, {
    prepared: String(result.prepared === true),
    ...(result.prepared ? { claim_name: `${result.key}-claim`, state_key: result.key } : {}),
  })
  // Only fixed status codes go into workflow commands and Markdown; all
  // source-controlled titles, branch names and test text stay inside JSON.
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n### Feishu notification\n\nOutcome: \`${result.outcome}\`\n\nReason: \`${result.reason ?? result.outcome}\`\n\nSee the preview and diagnostic artifacts. Source CI conclusions are unchanged.\n`
    )
  return result
}

function validateSource(run, repository, now) {
  if (run.repository?.full_name !== repository) throw new Error("source-repository-mismatch")
  if (run.status !== "completed") throw new Error("source-not-completed")
  const started = Date.parse(run.run_started_at)
  if (!Number.isFinite(started) || now() - started > 60 * DAY || started > now() + 60_000)
    throw new Error("source-outside-receipt-retention")
  if (!Object.hasOwn(WORKFLOWS, workflowFile(run))) throw new Error("unsupported-workflow")
}

async function sourceEvidence(client, env, repository, now) {
  const id = integer(env.SOURCE_RUN_ID)
  const run = await client.getRun(id)
  validateSource(run, repository, now)
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    if (event.workflow_run?.id !== id || event.repository?.full_name !== repository)
      throw new Error("source-event-mismatch")
    if (event.workflow_run.run_attempt !== run.run_attempt) return { superseded: true }
  }
  return { source: normalizeRun(run, await client.getJobs(id, run.run_attempt)) }
}

async function history(client, source) {
  const runs = (
    await client.listRecentRuns({
      workflowId: source.workflow_id,
      branch: source.head_branch,
      event: source.event,
    })
  )
    .filter((run) => run.id !== source.id && sameScope(source, run) && run.status === "completed")
    .sort(
      (a, b) => b.run_number - a.run_number || Date.parse(b.created_at) - Date.parse(a.created_at)
    )
  const newer = runs.some((run) => run.run_number > source.run_number)
  const previousRuns = runs.filter(
    (run) =>
      run.run_number < source.run_number &&
      !["cancelled", "skipped", "neutral"].includes(run.conclusion)
  )
  // GitHub reruns preserve run ID and run number. Their immediately preceding
  // attempts must participate in recovery and duplicate-failure policy too.
  for (
    let attempt = source.run_attempt - 1;
    attempt >= Math.max(1, source.run_attempt - 10);
    attempt -= 1
  ) {
    const previousAttempt = await client.getRun(source.id, attempt)
    if (
      previousAttempt.status === "completed" &&
      !["cancelled", "skipped", "neutral"].includes(previousAttempt.conclusion)
    ) {
      previousRuns.unshift(previousAttempt)
      break
    }
  }
  return { newer, previousRuns }
}

async function previousEvidence(client, source, runs, destination, repository, now) {
  let previous
  // Repeated failures are suppressed only after an accepted delivery with the
  // same job fingerprint. An unavailable/deleted receipt never means success.
  for (const [index, run] of runs.slice(0, 10).entries()) {
    const candidate = normalizeRun(run, await client.getJobs(run.id, run.run_attempt))
    if (index === 0) previous = candidate
    if (candidate.fingerprint !== source.fingerprint || !isFailure(source.status)) break
    if (now() - Date.parse(run.updated_at) > DAY) break
    const delivery = await inspectDelivery(client, {
      key: stateKey(candidate, destination),
      repository,
    })
    if (delivery.status === "accepted") return { previous, previousAccepted: true }
  }
  return { previous, previousAccepted: false }
}

function duration(start, end) {
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return "N/A"
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "size unavailable"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function reportLines(report) {
  const lines = []
  if (report.jest) {
    lines.push(
      `Jest (available artifacts): ${report.jest.passed} passed / ${report.jest.failed.length} failed / ${report.jest.skipped} skipped`
    )
    for (const test of report.jest.failed.slice(0, 3))
      lines.push(`Failed: ${test.suite} › ${test.name}`)
  }
  if (report.playwright) {
    lines.push(
      `Playwright: ${report.playwright.total} tests / ${report.playwright.failed.length} failed / ${report.playwright.flaky.length} flaky`
    )
    lines.push(
      `First-pass: ${report.playwright.firstPassRate ?? "N/A"}${report.playwright.firstPassRate == null ? "" : "%"} · p95 test duration: ${report.playwright.p95Duration}ms (available artifacts)`
    )
    for (const test of report.playwright.failed.slice(0, 2)) lines.push(`Failed: ${test.title}`)
    for (const test of report.playwright.flaky.slice(0, 2)) lines.push(`Flaky: ${test.title}`)
  }
  if (report.bundle)
    lines.push(`Bundle: ${sizeLabel(report.bundle.current.totalBytes)} (no baseline comparison)`)
  if (!report.jest && !report.playwright)
    lines.push("Test counts unavailable for this run; inspect GitHub jobs and artifacts.")
  return lines
}

async function sourceCard(client, source, decision, now) {
  const jobs = source.jobs
  const repository = source.repository.full_name
  const base = `https://github.com/${repository}`
  const runUrl = `${base}/actions/runs/${source.id}/attempts/${source.run_attempt}`
  const counts = new Map()
  for (const job of jobs) {
    const state = job.conclusion ?? job.status ?? "unknown"
    counts.set(state, (counts.get(state) ?? 0) + 1)
  }
  const warnings = []
  const sections = []
  const actions = [{ label: "View workflow", url: runUrl }]
  if (source.failed.length) {
    const lines = []
    const links = []
    for (const job of source.failed.slice(0, 5)) {
      lines.push(`${job.name} · ${job.conclusion}`)
      const steps = (job.steps ?? []).filter((step) => isFailure(step.conclusion))
      for (const step of steps.slice(0, 2)) {
        lines.push(`  Step ${step.number}: ${step.name}`)
        if (Number.isSafeInteger(step.number) && step.number > 0 && job.html_url)
          links.push({
            label: `Step ${step.number} · ${job.name}`,
            url: `${job.html_url.split("#")[0]}#step:${step.number}:1`,
          })
      }
      if (steps.length > 2) lines.push(`  +${steps.length - 2} more failed steps; open the job.`)
      if (!steps.length && job.html_url) links.push({ label: job.name, url: job.html_url })
    }
    if (source.failed.length > 5)
      lines.push(`+${source.failed.length - 5} more failed jobs; open the workflow.`)
    sections.push({ title: "Needs attention", lines, actions: links.slice(0, 3) })
    actions.unshift({
      label: "Investigate failure",
      url: links[0]?.url ?? source.failed[0].html_url ?? runUrl,
    })
  }
  const contextLines = [
    `${source.event} · ${source.head_branch ?? "unknown ref"} · ${source.actor?.login ?? "unknown actor"}`,
    `Commit: ${source.head_sha?.slice(0, 12) ?? "unknown"} · attempt ${source.run_attempt}`,
    `Jobs: ${Array.from(counts, ([state, count]) => `${count} ${state}`).join(" / ") || "none reported"}`,
  ]
  if (source.head_commit?.message) contextLines.push(source.head_commit.message.split("\n")[0])
  let pullRequests = (source.pull_requests ?? []).filter(
    (pr) => Number.isSafeInteger(pr.number) && pr.number > 0
  )
  if (!pullRequests.length && /^[a-f0-9]{40}$/i.test(source.head_sha ?? "")) {
    try {
      pullRequests = (await client.getPullRequestsForCommit(source.head_sha)).filter(
        (pr) =>
          Number.isSafeInteger(pr.number) &&
          pr.number > 0 &&
          pr.base?.repo?.full_name === repository &&
          (pr.head?.sha === source.head_sha || pr.merge_commit_sha === source.head_sha)
      )
    } catch {
      warnings.push("pr-metadata-unavailable")
    }
  }
  const contextActions = []
  for (const pr of pullRequests.slice(0, 2)) {
    contextLines.push(
      `PR #${pr.number}${pr.draft ? " · Draft" : ""}${pr.title ? ` · ${pr.title}` : ""}`
    )
    contextActions.push({ label: `PR #${pr.number}`, url: `${base}/pull/${pr.number}` })
  }
  if (pullRequests.length > 2)
    contextLines.push(`+${pullRequests.length - 2} associated PRs; see GitHub.`)
  if (!pullRequests.length && source.event === "pull_request")
    contextLines.push(
      `PR association unavailable · ${source.head_repository?.full_name ?? "unknown repository"} / ${source.head_branch}`
    )
  if (/^[a-f0-9]{40}$/i.test(source.head_sha ?? ""))
    contextActions.push({ label: "View commit", url: `${base}/commit/${source.head_sha}` })
  sections.push({ title: "Change context", lines: contextLines, actions: contextActions })

  if (source.route === "ci" && !["report.yml", "bootstrap-scripts.yml"].includes(source.file)) {
    const section = { title: "Test evidence", lines: [] }
    try {
      const inputs = await client.readReport(source.id, {
        attempt: source.run_attempt,
        startedAt: source.run_started_at,
        finishedAt: source.updated_at,
      })
      section.lines.push(...reportLines(assemble({ ...inputs, meta: {} })))
      warnings.push(...inputs.warnings)
    } catch {
      warnings.push("report-unavailable")
      section.lines.push("Test report unavailable; source workflow result is preserved.")
    }
    sections.push(section)
  }
  if (source.route === "ops" && source.targets.length) {
    const lines = source.targets.map((job) => `${job.name}: ${job.conclusion ?? "unknown"}`)
    const gate = jobs.find((job) => /Gate \((staging|production)\)/.test(job.name))
    if (gate) lines.unshift(`Environment: ${gate.name.match(/Gate \((staging|production)\)/)[1]}`)
    lines.push(
      "Deployment job results only; public endpoint health has not been verified by this notifier."
    )
    sections.push({ title: "Deployment targets", lines })
  }
  if (source.file === "release.yml") {
    const section = { title: "Release & downloads", lines: [], actions: [] }
    try {
      const release = await client.getRelease(source.head_branch)
      if (release && !release.draft) {
        const assets = (release.assets ?? []).filter(
          (asset) => asset.state == null || asset.state === "uploaded"
        )
        section.lines.push(
          `${release.tag_name} · ${release.prerelease ? "prerelease" : "stable"} · ${assets.length} assets`
        )
        section.actions.push({ label: "All release assets", url: release.html_url })
        // Prefer installable builds over signatures/manifests; retain the full release link.
        const downloads = [...assets]
          .sort(
            (a, b) =>
              Number(/\.(dmg|exe|msi|deb|rpm|AppImage|apk|ipa|zip|tar\.gz)$/i.test(b.name)) -
              Number(/\.(dmg|exe|msi|deb|rpm|AppImage|apk|ipa|zip|tar\.gz)$/i.test(a.name))
          )
          .slice(0, 2)
        for (const asset of downloads) {
          section.lines.push(`${asset.name} · ${sizeLabel(asset.size)}`)
          section.actions.push({ label: asset.name, url: asset.browser_download_url })
        }
        if (assets.length > downloads.length)
          section.lines.push(
            `+${assets.length - downloads.length} more assets on the release page.`
          )
        if (source.status !== "success")
          section.lines.push("Some release assets may already be public despite pipeline failure.")
      } else section.lines.push("No published release was found for this ref.")
    } catch {
      warnings.push("release-metadata-unavailable")
      section.lines.push("Release metadata unavailable; open the workflow for publishing results.")
    }
    section.lines.push(
      "Parent pipeline includes desktop, mobile and Agent stages. App Store availability is not verified."
    )
    sections.push(section)
  }
  try {
    const artifacts = (await client.listArtifacts({ runId: source.id })).filter(
      (artifact) =>
        Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        !artifact.expired &&
        artifact.workflow_run?.id === source.id &&
        Date.parse(artifact.expires_at) > now() &&
        Date.parse(artifact.created_at) >= Date.parse(source.run_started_at) &&
        Date.parse(artifact.created_at) <= Date.parse(source.updated_at) + 60_000
    )
    if (artifacts.length)
      sections.push({
        title: "Build artifacts",
        lines: [
          ...artifacts
            .slice(0, 3)
            .map(
              (artifact) =>
                `${artifact.name} · ${sizeLabel(artifact.size_in_bytes)} · expires ${artifact.expires_at.slice(0, 10)}`
            ),
          ...(artifacts.length > 3
            ? [`+${artifacts.length - 3} more artifacts on the workflow page.`]
            : []),
          "Current-attempt uploads · GitHub sign-in required · retention applies.",
        ],
        actions: artifacts.slice(0, 3).map((artifact) => ({
          label: artifact.name,
          url: `${base}/actions/runs/${source.id}/artifacts/${artifact.id}`,
        })),
      })
  } catch {
    warnings.push("artifact-metadata-unavailable")
  }
  if (source.file === "images.yml")
    sections.push({
      title: "Container images",
      lines: [
        "Image tags/digests are available in publishing job summaries; this card reports matrix completion.",
      ],
    })
  if (source.file === "sync-model-catalog.yml")
    actions.push({ label: "Review update PRs", url: `${base}/pulls` })
  const level = isFailure(source.status)
    ? "error"
    : source.status === "success"
      ? "success"
      : "warning"
  const state = decision.reason === "recovered" ? "recovered" : source.status
  return {
    card: renderCard({
      title: `${source.name}: ${state}`,
      subtitle: repository,
      summary: `${source.name}: ${state} · ${source.head_branch} · ${source.failed.length} failed jobs`,
      level,
      tags: [source.route.toUpperCase(), state, `#${source.run_number ?? source.id}`],
      metrics: [
        { label: "Passed jobs", value: String(counts.get("success") ?? 0) },
        { label: "Failed jobs", value: String(source.failed.length) },
        { label: "Skipped jobs", value: String(counts.get("skipped") ?? 0) },
        { label: "Run duration", value: duration(source.run_started_at, source.updated_at) },
      ],
      sections,
      actions,
      footer: warnings.length
        ? "Some optional metadata is unavailable. See notification diagnostics; source result is unchanged."
        : "Cognia · GitHub is the source of truth · links open in GitHub",
    }),
    warnings,
  }
}

async function digestEvidence(client, repository, now) {
  const end = new Date(now()).toISOString().slice(0, 10)
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - DAY).toISOString().slice(0, 10)
  const runs = (
    await client.listRuns({ created: `${start}T00:00:00Z..${start}T23:59:59Z` })
  ).filter((run) => Object.hasOwn(WORKFLOWS, workflowFile(run)))
  const failures = runs.filter((run) => run.status === "completed" && isFailure(run.conclusion))
  const successful = runs.filter(
    (run) => run.status === "completed" && run.conclusion === "success"
  ).length
  const conclusive = successful + failures.length
  const pending = runs.filter((run) => run.status !== "completed").length
  const cancelled = runs.filter(
    (run) => run.status === "completed" && run.conclusion === "cancelled"
  ).length
  const other = runs.length - conclusive - pending - cancelled
  const groups = new Map()
  for (const run of runs) {
    const file = workflowFile(run)
    const group = groups.get(file) ?? { name: run.name, total: 0, failed: 0 }
    group.total++
    if (run.status === "completed" && isFailure(run.conclusion)) group.failed++
    groups.set(file, group)
  }
  const ranked = [...groups.values()].sort(
    (a, b) => b.failed - a.failed || b.total - a.total || a.name.localeCompare(b.name)
  )
  const rate = conclusive ? `${((successful / conclusive) * 100).toFixed(1)}%` : "N/A"
  const card = renderCard({
    title: `Cognia daily workflows · ${start} UTC`,
    subtitle: repository,
    summary: `${runs.length} runs · ${failures.length} failed/action-required · ${rate} success`,
    level: failures.length ? "warning" : "info",
    tags: ["DAILY DIGEST", `${groups.size} workflows`],
    metrics: [
      { label: "Workflow runs", value: String(runs.length) },
      { label: "Needs attention", value: String(failures.length) },
      { label: "Success rate", value: rate },
      { label: "Pending", value: String(pending) },
    ],
    sections: [
      {
        title: "Reporting window",
        lines: [
          `Runs created ${start} 00:00–23:59 UTC; latest observed results, including latest rerun attempts.`,
          `${runs.length} runs · ${failures.length} failed/action-required`,
          `${successful} successful / ${conclusive} conclusive · ${pending} pending · ${cancelled} cancelled · ${other} skipped/neutral/unknown`,
          "Success rate = successful / (successful + failed/action-required). Pending, cancelled and skipped runs are excluded.",
          ...(runs.length ? [] : ["No workflow runs in this reporting window."]),
        ],
      },
      ...(failures.length
        ? [
            {
              title: "Failures to investigate",
              lines: failures
                .slice(0, 5)
                .map((run) => `${run.name} · ${run.head_branch} · #${run.run_number ?? run.id}`),
              actions: failures.slice(0, 3).map((run) => ({
                label: `${run.name} #${run.run_number ?? run.id}`,
                url: `https://github.com/${repository}/actions/runs/${run.id}`,
              })),
            },
          ]
        : []),
      {
        title: "Workflow breakdown",
        lines: ranked
          .slice(0, 15)
          .map((group) => `${group.name} · ${group.failed} failed / ${group.total} runs`),
      },
    ],
    actions: [
      { label: "GitHub Actions", url: `https://github.com/${repository}/actions` },
      { label: "Releases", url: `https://github.com/${repository}/releases` },
    ],
    footer:
      "Daily volume and observed status, not a deployment-health or cross-attempt test comparison.",
  })
  return {
    source: {
      id: `digest:${start}`,
      run_attempt: 1,
      route: "ops",
      file: "digest",
      repository: { full_name: repository },
    },
    card,
  }
}

export async function prepare({ env = process.env, client, now = Date.now } = {}) {
  const { dir, repository } = context(env)
  const dryRun = truth(env.DRY_RUN)
  if (!dryRun && !truth(env.FEISHU_ENABLED))
    return finish(env, dir, { outcome: "skipped", reason: "disabled", prepared: false })
  const digest = !env.SOURCE_RUN_ID
  if (digest && env.GITHUB_EVENT_NAME !== "workflow_dispatch" && !truth(env.FEISHU_DAILY_DIGEST))
    return finish(env, dir, { outcome: "skipped", reason: "digest-disabled", prepared: false })
  client ??= createGitHubClient({ repository, token: env.GITHUB_TOKEN })
  let source,
    card,
    decision,
    warnings = []
  if (digest) {
    ;({ source, card } = await digestEvidence(client, repository, now))
    decision = { send: true, reason: "daily-digest" }
  } else {
    const evidence = await sourceEvidence(client, env, repository, now)
    if (evidence.superseded)
      return finish(env, dir, { outcome: "skipped", reason: "superseded-attempt", prepared: false })
    source = evidence.source
    const destination = selectDestination(source.route, env)
    let past = { newer: false, previousRuns: [] },
      prior = {}
    if (env.FEISHU_MODE !== "all") {
      try {
        past = await history(client, source)
        prior = await previousEvidence(
          client,
          source,
          past.previousRuns,
          destination.url,
          repository,
          now
        )
      } catch {
        // History only reduces noise. Its outage must not hide a current failure.
        // The current delivery ledger below still fails closed on API errors.
        warnings.push("history-unavailable")
      }
    }
    const stale = past.newer && !["release.yml", "deploy.yml", "images.yml"].includes(source.file)
    decision = stale
      ? { send: false, reason: "superseded-run" }
      : decide(source, { mode: env.FEISHU_MODE || "changes", ...prior })
    const presentation = await sourceCard(client, source, decision, now)
    card = presentation.card
    warnings.push(...presentation.warnings)
  }
  save(dir, "preview.json", card)
  writeFileSync(resolve(dir, "preview.html"), renderPreview(card), { mode: 0o600 })
  const destination = selectDestination(source.route, env)
  const key = stateKey(source, destination.url)
  if (dryRun)
    return finish(env, dir, {
      outcome: "dry-run",
      reason: decision.reason,
      wouldSend: decision.send,
      prepared: false,
      warnings,
    })
  if (!decision.send)
    return finish(env, dir, {
      outcome: "suppressed",
      reason: decision.reason,
      prepared: false,
      warnings,
    })
  if (!destination.url || !destination.secret) throw new Error("missing-webhook-signing-pair")
  const delivery = await inspectDelivery(client, { key, repository })
  if (delivery.status === "accepted")
    return finish(env, dir, { outcome: "suppressed", reason: "already-accepted", prepared: false })
  const resendUnknown = env.GITHUB_EVENT_NAME === "workflow_dispatch" && truth(env.RESEND_UNKNOWN)
  if (delivery.status === "delivery-unknown" && !resendUnknown) {
    finish(env, dir, {
      outcome: "delivery-unknown",
      reason: "previous-claim-unresolved",
      prepared: false,
    })
    throw new Error("previous-delivery-unknown")
  }
  const plan = {
    version: 1,
    key,
    repository,
    route: source.route,
    sourceId: source.id,
    sourceAttempt: source.run_attempt,
    reporterRunId: integer(env.GITHUB_RUN_ID),
    preparedAt: now(),
    card,
    reason: decision.reason,
  }
  save(dir, "plan.json", plan)
  save(dir, "claim.json", {
    version: 1,
    key,
    repository,
    sourceId: source.id,
    sourceAttempt: source.run_attempt,
    preparedAt: now(),
    resendUnknown,
  })
  return finish(env, dir, {
    outcome: "prepared",
    reason: decision.reason,
    prepared: true,
    key,
    warnings,
  })
}

export async function deliver({
  env = process.env,
  client,
  send = sendWebhook,
  now = Date.now,
} = {}) {
  const { dir, repository } = context(env)
  if (!truth(env.FEISHU_ENABLED) || truth(env.DRY_RUN)) throw new Error("delivery-not-enabled")
  const plan = JSON.parse(readFileSync(resolve(dir, "plan.json"), "utf8"))
  if (
    plan.version !== 1 ||
    plan.repository !== repository ||
    plan.reporterRunId !== integer(env.GITHUB_RUN_ID) ||
    !/^feishu-v1-[a-f0-9]{32}$/.test(plan.key) ||
    now() - plan.preparedAt > 10 * 60_000 ||
    now() < plan.preparedAt
  )
    throw new Error("invalid-delivery-plan")
  const destination = selectDestination(plan.route, env)
  if (
    stateKey(
      {
        repository: { full_name: repository },
        id: plan.sourceId,
        run_attempt: plan.sourceAttempt,
        route: plan.route,
      },
      destination.url
    ) !== plan.key
  )
    throw new Error("destination-changed-after-prepare")
  client ??= createGitHubClient({ repository, token: env.GITHUB_TOKEN })
  if (!/^[1-9]\d*$/.test(env.CLAIM_ARTIFACT_ID ?? "")) throw new Error("missing-delivery-claim-id")
  const claim = await getCurrentClaim(client, {
    key: plan.key,
    repository,
    reporterRunId: plan.reporterRunId,
  })
  if (String(claim.id) !== env.CLAIM_ARTIFACT_ID) throw new Error("invalid-delivery-claim-id")
  let result
  // GitHub can cap requested retention to a shorter repository policy. Refuse
  // the POST unless the real durable claim covers our entire replay window.
  if (
    !Number.isFinite(Date.parse(claim.expires_at)) ||
    Date.parse(claim.expires_at) < now() + 60 * DAY
  ) {
    result = { outcome: "rejected", attempts: 0, reason: "insufficient-artifact-retention" }
  }
  if (!result && Number.isSafeInteger(plan.sourceId)) {
    const current = await client.getRun(plan.sourceId)
    if (current.run_attempt !== plan.sourceAttempt || current.status !== "completed")
      result = { outcome: "superseded", attempts: 0 }
  }
  result ??= await send({ ...destination, body: plan.card })
  const receipt = {
    version: 1,
    key: plan.key,
    sourceId: plan.sourceId,
    sourceAttempt: plan.sourceAttempt,
    claimId: claim.id,
    ...result,
    finishedAt: now(),
  }
  save(dir, "receipt.json", receipt)
  output(env, { receipt_name: receiptName(plan.key, result.outcome, claim.id) })
  finish(env, dir, {
    outcome: result.outcome,
    reason: result.reason ?? plan.reason,
    prepared: false,
    attempts: result.attempts,
  })
  return receipt
}

export async function main(command, env = process.env) {
  try {
    if (command === "prepare") await prepare({ env })
    else if (command === "deliver") {
      const result = await deliver({ env })
      if (!["accepted", "superseded"].includes(result.outcome)) return 1
    } else throw new Error("unknown-command")
    return 0
  } catch (error) {
    // Error messages from boundaries may contain tokens or attacker text.
    // Persist only an allowlisted code, never raw exception messages/stacks.
    const known =
      /^(?:invalid-[a-z-]+|missing-[a-z-]+|source-[a-z-]+|unsupported-workflow|incomplete-webhook-signing-pair|previous-delivery-unknown|destination-changed-after-prepare|delivery-not-enabled|unknown-command)$/
    const reason = known.test(error.message ?? "") ? error.message : "notification-operation-failed"
    try {
      const { dir } = context(env)
      finish(env, dir, { outcome: "error", reason, prepared: false })
    } catch {
      /* Output directory validation can itself be the failure. */
    }
    process.stderr.write(`Feishu notification: ${reason}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main(process.argv[2])
