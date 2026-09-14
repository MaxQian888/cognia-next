import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import type { Config } from "./config"
import {
  currentCiFailures,
  currentCiExecutions,
  GithubRequestError,
  githubReader,
  parseWork,
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

type Publications = NonNullable<
  Awaited<ReturnType<PluginContext["bots"]["getInstallation"]>>["publications"]
>
interface Published {
  attempts: number
  parentNumber?: number
  sourceRunId?: string
  headSha?: string
  ciStatus?: string
}

/** Recover correlation from host-owned publications, never from a public marker alone. */
async function recoverPublication(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  item: Item,
  publications: Publications,
  ancestors = new Set<number>()
): Promise<Published | undefined> {
  const key = `published:v1:${run.installationId}:${config.repository.toLowerCase()}:${item.number}`
  const saved = await ctx.storage.get<Published>(key)
  if (saved) return saved
  if (!item.body?.includes("<!-- cognia-github-devin:") || !publications.length) return
  const api = githubReader(ctx, run.runId, config.repository)
  const pr = item.head ? item : item.pull_request ? await api.item(item.number, "pr") : undefined
  if (!pr?.head || pr.head.repo?.full_name.toLowerCase() !== config.repository.toLowerCase()) return
  const matches = publications.flatMap((publication) => {
    if (
      publication.repository.toLowerCase() !== config.repository.toLowerCase() ||
      publication.branch !== pr.head!.ref ||
      publication.headSha !== pr.head!.sha
    )
      return []
    try {
      const work = parseWork(publication.sourcePayload, config.repository)
      return work.mode !== "review" &&
        pr.body?.includes(`<!-- cognia-github-devin:${workId(work)} -->`)
        ? [{ publication, work }]
        : []
    } catch {
      return []
    }
  })
  // Conflicting publication identities cannot establish which repair budget applies.
  if (matches.length !== 1) return
  const { publication, work } = matches[0]
  let attempts = 0
  if (work.mode === "repair") {
    attempts = config.maxRepairAttempts
    if (!ancestors.has(pr.number) && ancestors.size < config.maxRepairAttempts) {
      const parent = await api.item(work.number, "pr")
      const previous = await recoverPublication(
        ctx,
        run,
        config,
        parent,
        publications,
        new Set([...ancestors, pr.number])
      )
      // Uncorrelated marked parents may be older than the host's bounded history.
      // Keep their repair budget exhausted instead of silently resetting it.
      if (previous) attempts = Math.min(config.maxRepairAttempts, previous.attempts + 1)
      else if (!parent.body?.includes("<!-- cognia-github-devin:")) attempts = 1
    }
  }
  const recovered: Published = {
    attempts,
    parentNumber: work.number,
    sourceRunId: publication.sourceRunId,
    headSha: publication.headSha,
  }
  await ctx.storage.set(key, recovered)
  return recovered
}

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
  backfill: boolean,
  publications: Publications
) {
  const api = githubReader(ctx, run.runId, config.repository)
  if (item.state !== "open") {
    await ctx.bots.cancelResource(run.runId, {
      resourceId: resourceId(config.repository, item.number),
    })
    return 0
  }
  const includedKey = `included:v1:${run.installationId}:${config.repository.toLowerCase()}:${item.number}`
  const produced = await recoverPublication(ctx, run, config, item, publications)
  if (
    !backfill &&
    !produced &&
    Date.parse(item.created_at) < cursor.watermark &&
    !(await ctx.storage.get<boolean>(includedKey))
  )
    return 0
  if (backfill) await ctx.storage.set(includedKey, true)
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
  const checks = await api.pages<CheckRun>(`/commits/${pr.head.sha}/check-runs`, "check_runs")
  const failures = currentCiFailures(workflows, checks, pr.head.sha)
  const failure = failures.workflows[0]
  const failed = Boolean(failure) || failures.checks.length > 0
  if (produced?.headSha === pr.head.sha) {
    const latest = currentCiExecutions(workflows, checks, pr.head.sha)
    const ciStatus = failed
      ? "failed"
      : (!latest.workflows.length && !latest.checks.length) ||
          latest.workflows.some((workflow) => workflow.status !== "completed") ||
          latest.checks.some((check) => check.status !== "completed")
        ? "pending"
        : "completed"
    if (produced.ciStatus !== ciStatus) {
      await ctx.storage.set(
        `published:v1:${run.installationId}:${config.repository.toLowerCase()}:${pr.number}`,
        { ...produced, ciStatus }
      )
      run.log(ciStatus === "failed" ? "warn" : "info", "Published PR CI changed", {
        number: pr.number,
        sha: pr.head.sha,
        ciStatus,
      })
    }
  }
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
        const payload = run.event.payload as {
          repository?: { full_name?: string }
          issue?: Item
          pull_request?: Item
          check_run?: { head_sha?: string; pull_requests?: { number: number }[] }
          workflow_run?: WorkflowRun
        }
        if (payload.repository?.full_name?.toLowerCase() !== config.repository.toLowerCase())
          return []
        if (run.event.provenance.selfProduced) {
          const sha = payload.check_run?.head_sha ?? payload.workflow_run?.head_sha
          const numbers =
            payload.check_run?.pull_requests ?? payload.workflow_run?.pull_requests ?? []
          if (!["check_run.completed", "workflow_run.completed"].includes(run.event.type) || !sha)
            return []
          const correlated: Item[] = []
          for (const { number } of numbers) {
            const current = await api.item(number, "pr")
            const produced = await recoverPublication(
              ctx,
              run,
              config,
              current,
              installation.publications ?? []
            )
            if (produced?.headSha === sha && produced.sourceRunId) {
              if (current.head?.sha === sha) correlated.push(current)
            }
          }
          return correlated
        }
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
        reconcileItem(ctx, run, config, item, cursor, backfill, installation.publications ?? [])
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
