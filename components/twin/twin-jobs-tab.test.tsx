/**
 * @jest-environment jsdom
 *
 * Coverage for the Jobs tab: empty state, row rendering by status, retry
 * action on failed jobs, and queue-ingest/queue-distill buttons.
 */

import "fake-indexeddb/auto"
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("motion/react", () => ({
  motion: {
    li: ({ children, className, ...props }: React.LiHTMLAttributes<HTMLLIElement>) => (
      <li className={className} {...props}>
        {children}
      </li>
    ),
    span: ({ children, className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span className={className} {...props}>
        {children}
      </span>
    ),
  },
  useReducedMotion: () => true,
}))

import { TwinJobsTab } from "./twin-jobs-tab"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createTwinSource } from "@/lib/db/twin-sources"
import type { TwinJob } from "@/types/twin"

async function seedJob(overrides: Partial<TwinJob> = {}): Promise<TwinJob> {
  const job: TwinJob = {
    id: overrides.id ?? `job_${Math.random().toString(36).slice(2, 8)}`,
    twinId: "twin_alice",
    kind: "ingest",
    phase: "parse",
    status: "queued",
    queuedAt: Date.now(),
    progress: 0,
    retryCount: 0,
    sourceIds: [],
    metadata: {},
    ...overrides,
  } as TwinJob
  await getDb().twinJobs.put(job)
  return job
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await Promise.all([getDb().twinJobs.clear(), getDb().twinSources.clear()])
})

describe("TwinJobsTab", () => {
  it("renders the empty hint when there are no jobs", async () => {
    render(<TwinJobsTab twinId="twin_alice" />)
    expect(await screen.findByText(/No jobs yet/i)).toBeInTheDocument()
  })

  it("renders a job row with its translated status label", async () => {
    await seedJob({ id: "job_a", status: "running", phase: "embed", retryCount: 0 })
    render(<TwinJobsTab twinId="twin_alice" />)
    const statusBadge = await screen.findByTestId("twin-job-job_a-status")
    expect(statusBadge.textContent).toMatch(/Running/i)
    // STATUS_VARIANT maps "running" → "secondary".
    expect(statusBadge.getAttribute("data-variant")).toBe("secondary")
  })

  it("surfaces per-agent partial failures on a completed distill job", async () => {
    await seedJob({
      id: "job_pf",
      kind: "distill",
      status: "completed",
      phase: "completed",
      progress: 100,
      outputDraftIds: ["twd_1"],
      partialFailures: {
        knowledge: "timed out after 90s",
        playbook: "LLM returned no JSON",
      },
    })
    render(<TwinJobsTab twinId="twin_alice" />)
    // A non-destructive warning badge + each failed agent and its reason.
    expect(await screen.findByText(/timed out after 90s/i)).toBeInTheDocument()
    expect(screen.getByText(/LLM returned no JSON/i)).toBeInTheDocument()
    expect(screen.getByText(/knowledge/i)).toBeInTheDocument()
  })

  it("does not show the partial-failure block when the map is empty", async () => {
    await seedJob({
      id: "job_clean",
      kind: "distill",
      status: "completed",
      phase: "completed",
      progress: 100,
      outputDraftIds: ["twd_1"],
      partialFailures: {},
    })
    render(<TwinJobsTab twinId="twin_alice" />)
    await screen.findByTestId("twin-job-job_clean-status")
    expect(screen.queryByTestId("twin-job-job_clean-partial")).not.toBeInTheDocument()
  })

  it("uses the destructive variant for failed jobs and shows the error", async () => {
    await seedJob({
      id: "job_b",
      status: "failed",
      errorMessage: "embedding API rate limit",
    })
    render(<TwinJobsTab twinId="twin_alice" />)
    const statusBadge = await screen.findByTestId("twin-job-job_b-status")
    expect(statusBadge.getAttribute("data-variant")).toBe("destructive")
    expect(screen.getByText(/embedding API rate limit/)).toBeInTheDocument()
  })

  it("exposes a Retry button only for failed jobs", async () => {
    await seedJob({ id: "job_ok", status: "completed" })
    await seedJob({ id: "job_bad", status: "failed", errorMessage: "boom" })
    render(<TwinJobsTab twinId="twin_alice" />)
    await screen.findByTestId("twin-job-job_ok-status")
    expect(screen.queryByTestId("twin-job-retry-job_ok")).toBeNull()
    expect(screen.getByTestId("twin-job-retry-job_bad")).toBeInTheDocument()
  })

  it("queue-distill button enqueues a distill job", async () => {
    render(<TwinJobsTab twinId="twin_alice" />)
    const distillBtn = await screen.findByRole("button", { name: /Queue distill/i })
    await userEvent.click(distillBtn)
    await waitFor(async () => {
      const jobs = await getDb().twinJobs.where("twinId").equals("twin_alice").toArray()
      expect(jobs.some((j) => j.kind === "distill")).toBe(true)
    })
  })

  it("retrying a failed job requeues it", async () => {
    await seedJob({ id: "job_retry", status: "failed", errorMessage: "boom", retryCount: 1 })
    render(<TwinJobsTab twinId="twin_alice" />)
    await userEvent.click(await screen.findByTestId("twin-job-retry-job_retry"))
    await waitFor(async () => {
      const updated = await getDb().twinJobs.get("job_retry")
      expect(updated?.status).toBe("queued")
    })
  })

  it("queue-ingest button picks up pending sources", async () => {
    await createTwinSource({
      twinId: "twin_alice",
      kind: "document",
      format: "markdown",
      source: "/x.md",
      title: "X",
      bytes: 10,
      fingerprint: "fp",
      redacted: false,
      status: "pending",
    })
    render(<TwinJobsTab twinId="twin_alice" />)
    const ingestBtn = await screen.findByRole("button", { name: /Queue ingest/i })
    await userEvent.click(ingestBtn)
    await waitFor(async () => {
      const jobs = await getDb().twinJobs.where("twinId").equals("twin_alice").toArray()
      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs[0].kind).toBe("ingest")
    })
  })
})
