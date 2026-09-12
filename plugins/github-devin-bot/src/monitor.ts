import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import type { Config } from "./config"
import {
  failedConclusion,
  GithubRequestError,
  githubReader,
  resourceId,
  workId,
  type Item,
  type Work,
  type WorkflowRun,
  type CheckRun,
} from "./github"

interface MonitorCursor {
  version: 1
  watermark: number
  since: string
  pulls: Item[]
  pullsEtag?: string
  lastScanAt?: number
  retryAt?: number
}

const storageKey = (run: BotRunContextV1, repository: string) =>
  `monitor:v1:${run.installationId}:${repository.toLowerCase()}`

/** Delivery insertion is durable and idempotent; the short poll never parks on an approval. */
async function enqueue(ctx: PluginContext, run: BotRunContextV1, work: Work) {
  const key = `dispatched:v1:${run.installationId}:${workId(work)}`
  if (await ctx.storage.get<boolean>(key)) return 0
  await ctx.bots.enqueue(run.runId, {
    triggerId: "work",
    eventId: workId(work),
    type: "github-devin.work",
    payload: work,
    resource: {
      kind: work.kind === "pr" ? "pull_request" : "issue",
      id: resourceId(work.repository, work.number),
      scope: work.repository,
    },
  })
  await ctx.storage.set(key, true)
  return 1
}

async function reconcileItem(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  item: Item,
  cursor: MonitorCursor,
  backfill: boolean
) {
  const api = githubReader(ctx, run.runId, config.repository)
  if (item.state !== "open") {
    await ctx.bots.cancelResource(run.runId, {
      resourceId: resourceId(config.repository, item.number),
    })
    return 0
  }
  const includedKey = `included:v1:${run.installationId}:${config.repository.toLowerCase()}:${item.number}`
  if (
    !backfill &&
    Date.parse(item.created_at) < cursor.watermark &&
    !(await ctx.storage.get<boolean>(includedKey))
  )
    return 0
  if (backfill) await ctx.storage.set(includedKey, true)
  const produced = await ctx.storage.get<{ attempts: number }>(
    `published:v1:${run.installationId}:${config.repository.toLowerCase()}:${item.number}`
  )
  if (item.body?.includes("<!-- cognia-github-devin:") && !produced) return 0
  if (!item.head && !item.pull_request) {
    return enqueue(ctx, run, {
      repository: config.repository,
      number: item.number,
      kind: "issue",
      mode: "implement",
      revision: item.created_at,
    })
  }
  const pr = item.head ? item : await api.item(item.number, "pr")
  if (pr.draft || !pr.head || !pr.base) return 0
  await ctx.bots.cancelResource(run.runId, {
    resourceId: resourceId(config.repository, pr.number),
    exceptRevision: pr.head.sha,
  })
  let dispatched = 0
  if (!produced)
    dispatched += await enqueue(ctx, run, {
      repository: config.repository,
      number: pr.number,
      kind: "pr",
      mode: "review",
      revision: pr.head.sha,
    })
  const workflows = await api.pages<WorkflowRun>(
    `/actions/runs?head_sha=${encodeURIComponent(pr.head.sha)}`,
    "workflow_runs"
  )
  const failure = workflows.find(
    (workflow) => workflow.head_sha === pr.head!.sha && failedConclusion(workflow.conclusion)
  )
  const checks = await api.pages<CheckRun>(`/commits/${pr.head.sha}/check-runs`, "check_runs")
  const failed =
    Boolean(failure) ||
    checks.some((check) => check.head_sha === pr.head!.sha && failedConclusion(check.conclusion))
  if (failed && (!produced || produced.attempts < config.maxRepairAttempts)) {
    dispatched += await enqueue(ctx, run, {
      repository: config.repository,
      number: pr.number,
      kind: "pr",
      mode: "repair",
      revision: pr.head.sha,
      ...(failure ? { workflowRunId: failure.id, workflowAttempt: failure.run_attempt } : {}),
    })
  }
  if (failed && produced && produced.attempts >= config.maxRepairAttempts) {
    const key = `exhausted:v1:${run.installationId}:${config.repository.toLowerCase()}:${pr.number}:${pr.head.sha}`
    if (!(await ctx.storage.get<boolean>(key))) {
      run.log("error", "Automatic CI repair limit reached; human intervention is required", {
        repository: config.repository,
        number: pr.number,
        sha: pr.head.sha,
      })
      await ctx.storage.set(key, true)
    }
  }
  return dispatched
}

export async function monitor(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  now = Date.now
) {
  const installation = await ctx.bots.getInstallation(run.runId)
  const key = storageKey(run, config.repository)
  const previous = await ctx.storage.get<MonitorCursor>(key)
  const watermark = installation.activatedAt ?? now()
  const cursor: MonitorCursor =
    previous?.version === 1
      ? previous
      : {
          version: 1,
          watermark,
          since: new Date(watermark).toISOString(),
          pulls: [],
        }
  // A manual inspection can precede arming. Once armed, its earlier cursor
  // must not enroll items that were already historical at activation.
  if (installation.activatedAt !== undefined && installation.activatedAt > cursor.watermark) {
    cursor.watermark = installation.activatedAt
    cursor.since = new Date(Math.max(Date.parse(cursor.since), cursor.watermark)).toISOString()
  }
  const backfill = run.event.triggerId === "backfill"
  // Manual backfill names individual items. An empty Run now never launches the historical backlog.
  const rawSelected =
    backfill && typeof run.event.payload === "object" && run.event.payload !== null
      ? (run.event.payload as { numbers?: unknown }).numbers
      : undefined
  const selected =
    typeof rawSelected === "string"
      ? rawSelected
          .split(",")
          .map((value) => (/^\s*[1-9][0-9]*\s*$/.test(value) ? Number(value.trim()) : NaN))
      : rawSelected
  if (
    backfill &&
    (!Array.isArray(selected) ||
      !selected.length ||
      selected.length > 100 ||
      selected.some((n) => !Number.isSafeInteger(n) || n < 1))
  ) {
    throw new Error("Backfill requires 1–100 explicit issue/PR numbers in payload.numbers")
  }
  if (!backfill && cursor.retryAt && cursor.retryAt > now())
    return { summary: "GitHub rate-limit backoff", output: { retryAt: cursor.retryAt } }
  const scanEvery = installation.webhookEnabled ? 300_000 : 60_000
  if (
    !backfill &&
    run.event.source !== "integration" &&
    cursor.lastScanAt &&
    now() - cursor.lastScanAt < scanEvery
  ) {
    return {
      summary: "Waiting for the next reconciliation",
      output: { cursor: JSON.stringify(cursor) },
    }
  }
  const api = githubReader(ctx, run.runId, config.repository, now)
  const scanAt = now()
  try {
    const items = await run.step.run("read-changes", async () => {
      if (backfill)
        return Promise.all((selected as number[]).map((number) => api.item(number, "issue")))
      if (run.event.source === "integration") {
        if (run.event.provenance.selfProduced) return []
        const payload = run.event.payload as {
          repository?: { full_name?: string }
          issue?: Item
          pull_request?: Item
          check_run?: { pull_requests?: { number: number }[] }
          workflow_run?: WorkflowRun
        }
        if (payload.repository?.full_name?.toLowerCase() !== config.repository.toLowerCase())
          return []
        if (payload.issue) return [await api.item(payload.issue.number, "issue")]
        if (payload.pull_request) return [await api.item(payload.pull_request.number, "pr")]
        const numbers =
          payload.check_run?.pull_requests?.map((pr) => pr.number) ??
          payload.workflow_run?.pull_requests?.map((pr) => pr.number) ??
          []
        return Promise.all(numbers.map((number) => api.item(number, "pr")))
      }
      const issues = await api.pages<Item>(
        `/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(cursor.since)}`
      )
      const response = await api.request<Item[]>(
        "/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1",
        cursor.pullsEtag
      )
      if (response.status !== 304) {
        if (!Array.isArray(response.data)) throw new Error("Invalid GitHub pull request collection")
        cursor.pulls = /rel="next"/.test(response.headers.link ?? "")
          ? await api.pages<Item>("/pulls?state=open&sort=updated&direction=desc")
          : response.data
        cursor.pullsEtag = response.headers.etag
      }
      // CI does not update issue.updated_at. Inspect cached open heads even on HTTP 304.
      const merged = new Map(issues.map((item) => [item.number, item]))
      for (const pr of cursor.pulls) merged.set(pr.number, pr)
      return Array.from(merged.values())
    })
    let dispatched = 0
    for (const item of items) {
      run.signal.throwIfAborted()
      dispatched += await run.step.run(`dispatch-${item.number}`, () =>
        reconcileItem(ctx, run, config, item, cursor, backfill)
      )
    }
    // Commit a cursor only after every delivery insertion succeeds. A failed scan replays safely.
    if (!backfill && run.event.source !== "integration") {
      cursor.since = new Date(Math.max(cursor.watermark, scanAt - 1000)).toISOString()
      cursor.lastScanAt = scanAt
    }
    delete cursor.retryAt
    await ctx.storage.set(key, cursor)
    await ctx.bots.recordMonitor(run.runId, {
      lastSuccessAt: scanAt,
      lastError: undefined,
      retryAt: undefined,
      cursor: JSON.stringify(cursor),
    })
    return {
      summary: dispatched
        ? `Reconciled ${items.length} items; work queued`
        : "Repository synchronized; no actionable changes",
      output: { cursor: JSON.stringify(cursor), items: items.length, dispatched },
    }
  } catch (error) {
    if (error instanceof GithubRequestError && error.retryAt) {
      cursor.retryAt = error.retryAt
      await ctx.storage.set(key, cursor)
    }
    await ctx.bots.recordMonitor(run.runId, {
      lastError: error instanceof Error ? error.message : String(error),
      retryAt: cursor.retryAt,
    })
    throw error
  }
}
