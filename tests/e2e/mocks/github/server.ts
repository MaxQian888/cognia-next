/**
 * Mock GitHub REST API for E2E workflow tests.
 *
 * Implements the subset of api.github.com that the 13 `action.github.*`
 * executors plus the GitHub Delivery plugin call:
 *
 *   GET    /repos/:owner/:repo                       — repo metadata
 *   GET    /repos/:owner/:repo/pulls                 — list PRs
 *   POST   /repos/:owner/:repo/pulls                 — open PR
 *   GET    /repos/:owner/:repo/pulls/:n              — get PR
 *   PATCH  /repos/:owner/:repo/pulls/:n              — close/edit PR
 *   PUT    /repos/:owner/:repo/pulls/:n/merge        — merge PR
 *   POST   /repos/:owner/:repo/pulls/:n/reviews      — submit review (APPROVE / REQUEST_CHANGES / COMMENT)
 *   POST   /repos/:owner/:repo/pulls/:n/comments     — inline review comment
 *   POST   /repos/:owner/:repo/issues                — create issue
 *   POST   /repos/:owner/:repo/issues/:n/comments    — issue comment
 *   POST   /repos/:owner/:repo/issues/:n/labels      — add labels
 *   PATCH  /repos/:owner/:repo/issues/:n             — close issue
 *   POST   /repos/:owner/:repo/releases              — create release
 *   POST   /repos/:owner/:repo/releases/generate-notes — auto-changelog
 *   POST   /repos/:owner/:repo/git/refs              — push tag (refs/tags/x)
 *   POST   /repos/:owner/:repo/dispatches            — workflow_dispatch
 *
 * Specs flip the credential store baseUrl to `server.baseUrl` and assert on
 * `capturedCalls` after the executor runs.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const createExpressApp = () => require("express")() as import("express").Application

import type { Server } from "http"

export interface CapturedCall {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

export type GithubScenario =
  | { kind: "ok" }
  | { kind: "rate-limited"; retryAfterSeconds?: number }
  | { kind: "auth-error" }
  | { kind: "not-found" }
  | { kind: "validation-failed"; message: string }
  | { kind: "server-error"; status: number; message: string }

export interface MockGithubServer {
  start(port?: number): Promise<void>
  stop(): Promise<void>
  readonly port: number
  readonly baseUrl: string

  setScenario(scenario: GithubScenario): void
  /** Pre-seed the mock with a PR payload that GETs will return. */
  setPullRequest(
    owner: string,
    repo: string,
    number: number,
    payload: Record<string, unknown>
  ): void
  /** Pre-seed the mock with an issue payload. */
  setIssue(owner: string, repo: string, number: number, payload: Record<string, unknown>): void

  /** Wait until at least N captured calls match the given predicate. */
  waitForCalls(
    predicate: (call: CapturedCall) => boolean,
    count?: number,
    timeoutMs?: number
  ): Promise<CapturedCall[]>
  /** All captured calls so far. */
  readonly capturedCalls: CapturedCall[]
  reset(): void
}

export function createMockGithubServer(): MockGithubServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = createExpressApp() as any
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require("express") as typeof import("express")
  app.use(express.json({ limit: "4mb" }))

  let server: Server | null = null
  let _port = 0
  let scenario: GithubScenario = { kind: "ok" }
  const capturedCalls: CapturedCall[] = []
  const callResolvers: Array<{
    predicate: (call: CapturedCall) => boolean
    count: number
    resolve: () => void
  }> = []
  const pullRequests = new Map<string, Record<string, unknown>>()
  const issues = new Map<string, Record<string, unknown>>()

  const prKey = (owner: string, repo: string, n: number) => `${owner}/${repo}#${n}`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const capture = (req: any) => {
    const call: CapturedCall = {
      method: req.method,
      path: req.path,
      body: req.body,
      headers: Object.fromEntries(
        Object.entries(req.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          Array.isArray(v) ? v.join(",") : String(v),
        ])
      ),
    }
    capturedCalls.push(call)
    for (const r of callResolvers.slice()) {
      const matched = capturedCalls.filter(r.predicate).length
      if (matched >= r.count) {
        r.resolve()
        const i = callResolvers.indexOf(r)
        if (i !== -1) callResolvers.splice(i, 1)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guard = (res: any): boolean => {
    switch (scenario.kind) {
      case "rate-limited":
        res.set("retry-after", String(scenario.retryAfterSeconds ?? 1))
        res.set("x-ratelimit-remaining", "0")
        res.status(403).json({ message: "API rate limit exceeded" })
        return true
      case "auth-error":
        res.status(401).json({ message: "Bad credentials" })
        return true
      case "not-found":
        res.status(404).json({ message: "Not Found" })
        return true
      case "validation-failed":
        res.status(422).json({ message: scenario.message })
        return true
      case "server-error":
        res.status(scenario.status).json({ message: scenario.message })
        return true
      default:
        return false
    }
  }

  // ── Repo metadata ────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/repos/:owner/:repo", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.json({
      id: 1,
      name: req.params.repo,
      full_name: `${req.params.owner}/${req.params.repo}`,
      default_branch: "main",
    })
  })

  // ── Pull requests ────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/repos/:owner/:repo/pulls", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.json(
      [...pullRequests.entries()]
        .filter(([k]) => k.startsWith(`${req.params.owner}/${req.params.repo}#`))
        .map(([, v]) => v)
    )
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/pulls", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    const n = pullRequests.size + 1
    const pr = {
      number: n,
      id: n,
      state: "open",
      title: (req.body as { title?: string }).title ?? "",
      body: (req.body as { body?: string }).body ?? "",
      head: { ref: (req.body as { head?: string }).head ?? "" },
      base: { ref: (req.body as { base?: string }).base ?? "main" },
      html_url: `https://github.com/${req.params.owner}/${req.params.repo}/pull/${n}`,
    }
    pullRequests.set(prKey(req.params.owner, req.params.repo, n), pr)
    res.status(201).json(pr)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/repos/:owner/:repo/pulls/:n", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    const pr = pullRequests.get(prKey(req.params.owner, req.params.repo, Number(req.params.n)))
    if (!pr) return res.status(404).json({ message: "Not Found" })
    res.json(pr)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/repos/:owner/:repo/pulls/:n", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    const key = prKey(req.params.owner, req.params.repo, Number(req.params.n))
    const prev = pullRequests.get(key) ?? { number: Number(req.params.n) }
    const next = { ...prev, ...(req.body as Record<string, unknown>) }
    pullRequests.set(key, next)
    res.json(next)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.put("/repos/:owner/:repo/pulls/:n/merge", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.json({ sha: `sha_${req.params.n}`, merged: true, message: "merged" })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/pulls/:n/reviews", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.status(201).json({
      id: capturedCalls.length,
      state: (req.body as { event?: string }).event ?? "COMMENTED",
      body: (req.body as { body?: string }).body ?? "",
    })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/pulls/:n/comments", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.status(201).json({ id: capturedCalls.length, ...(req.body as Record<string, unknown>) })
  })

  // ── Issues ───────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/issues", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    const n = issues.size + 1
    const issue = {
      number: n,
      id: n,
      state: "open",
      title: (req.body as { title?: string }).title ?? "",
      body: (req.body as { body?: string }).body ?? "",
      html_url: `https://github.com/${req.params.owner}/${req.params.repo}/issues/${n}`,
    }
    issues.set(prKey(req.params.owner, req.params.repo, n), issue)
    res.status(201).json(issue)
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/issues/:n/comments", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.status(201).json({ id: capturedCalls.length, ...(req.body as Record<string, unknown>) })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/issues/:n/labels", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    const labels = (req.body as { labels?: string[] }).labels ?? []
    res.json(labels.map((name) => ({ id: capturedCalls.length, name })))
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/repos/:owner/:repo/issues/:n", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    const key = prKey(req.params.owner, req.params.repo, Number(req.params.n))
    const prev = issues.get(key) ?? { number: Number(req.params.n) }
    const next = { ...prev, ...(req.body as Record<string, unknown>) }
    issues.set(key, next)
    res.json(next)
  })

  // ── Releases ─────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/releases", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.status(201).json({
      id: capturedCalls.length,
      tag_name: (req.body as { tag_name?: string }).tag_name ?? "",
      name: (req.body as { name?: string }).name ?? "",
      body: (req.body as { body?: string }).body ?? "",
      html_url: `https://github.com/${req.params.owner}/${req.params.repo}/releases/tag/${(req.body as { tag_name?: string }).tag_name ?? ""}`,
    })
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/releases/generate-notes", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.json({
      name: `Release ${(req.body as { tag_name?: string }).tag_name ?? ""}`,
      body: "## Changes\n- mock changelog entry",
    })
  })

  // ── Git refs / tags ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/git/refs", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.status(201).json({
      ref: (req.body as { ref?: string }).ref ?? "",
      object: { sha: (req.body as { sha?: string }).sha ?? "" },
    })
  })

  // ── workflow_dispatch ────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.post("/repos/:owner/:repo/dispatches", (req: any, res: any) => {
    capture(req)
    if (guard(res)) return
    res.status(204).end()
  })

  return {
    async start(port = 0): Promise<void> {
      await new Promise<void>((resolve) => {
        server = app.listen(port, () => {
          const addr = server!.address()
          _port = typeof addr === "object" && addr ? addr.port : port
          resolve()
        })
      })
    },
    async stop(): Promise<void> {
      if (!server) return
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()))
      })
      server = null
    },
    get port() {
      return _port
    },
    get baseUrl() {
      return `http://127.0.0.1:${_port}`
    },
    setScenario(next) {
      scenario = next
    },
    setPullRequest(owner, repo, number, payload) {
      pullRequests.set(prKey(owner, repo, number), { number, ...payload })
    },
    setIssue(owner, repo, number, payload) {
      issues.set(prKey(owner, repo, number), { number, ...payload })
    },
    waitForCalls(predicate, count = 1, timeoutMs = 5_000) {
      const already = capturedCalls.filter(predicate)
      if (already.length >= count) return Promise.resolve(already.slice(0, count))
      return new Promise<CapturedCall[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = callResolvers.findIndex((r) => r.predicate === predicate)
          if (i !== -1) callResolvers.splice(i, 1)
          reject(new Error(`waitForCalls timed out after ${timeoutMs} ms`))
        }, timeoutMs)
        callResolvers.push({
          predicate,
          count,
          resolve: () => {
            clearTimeout(timer)
            resolve(capturedCalls.filter(predicate).slice(0, count))
          },
        })
      })
    },
    get capturedCalls() {
      return capturedCalls
    },
    reset() {
      scenario = { kind: "ok" }
      capturedCalls.length = 0
      callResolvers.length = 0
      pullRequests.clear()
      issues.clear()
    },
  }
}
