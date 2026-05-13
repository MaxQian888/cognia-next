"use client"

/**
 * Usage sub-tab. Polls `/rate_limit` for each registered repo every 60s and
 * renders a card per repo showing core / search / graphql remaining quota
 * with reset-time hints.
 */

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { GaugeIcon, RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { getDb } from "@/lib/db/schema"
import { getGithubRuntime } from "@/plugins/github-delivery/src/workflow/runtime"
import {
  fetchRateLimit,
  formatReset,
  percentRemaining,
  type RateLimitSnapshot,
} from "@/lib/github/rate-limit"
import type { GhRepoEntry } from "@/lib/github/types"
import type Dexie from "dexie"

const NAMESPACED_TABLE = "github-delivery:repos"
const POLL_INTERVAL_MS = 60_000

function getReposTable(): Dexie.Table<GhRepoEntry, string> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhRepoEntry, string>(NAMESPACED_TABLE)
  } catch {
    return null
  }
}

interface SnapshotState {
  byRepo: Map<string, RateLimitSnapshot>
  errors: Map<string, string>
  lastRefreshAt: number | null
}

export function UsageTab() {
  const repos = useLiveQuery(async () => {
    const t = getReposTable()
    if (!t) return null
    try {
      return await t.toArray()
    } catch {
      return null
    }
  })

  const [state, setState] = useState<SnapshotState>({
    byRepo: new Map(),
    errors: new Map(),
    lastRefreshAt: null,
  })
  const [refreshing, setRefreshing] = useState(false)
  const [nowTick, setNowTick] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    if (!repos || repos.length === 0) return
    const rt = getGithubRuntime()
    if (!rt) return
    setRefreshing(true)
    const newByRepo = new Map<string, RateLimitSnapshot>()
    const newErrors = new Map<string, string>()
    await Promise.all(
      repos.map(async (repo) => {
        try {
          const octokit = await rt.getOctokit(repo.fullName)
          const snap = await fetchRateLimit(octokit, repo.fullName)
          newByRepo.set(repo.fullName, snap)
        } catch (err) {
          newErrors.set(repo.fullName, err instanceof Error ? err.message : String(err))
        }
      })
    )
    setState({ byRepo: newByRepo, errors: newErrors, lastRefreshAt: Date.now() })
    setRefreshing(false)
  }, [repos])

  useEffect(() => {
    if (!repos || repos.length === 0) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refresh()
    })
    const id = setInterval(() => {
      void refresh()
      setNowTick(Date.now())
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [repos?.length, refresh])

  if (repos === null) {
    return (
      <Card className="p-4" data-testid="usage-tab">
        <p className="text-sm text-muted-foreground">
          API quota requires the GitHub Delivery plugin to be enabled.
        </p>
      </Card>
    )
  }

  if (!repos || repos.length === 0) {
    return (
      <Card className="p-4" data-testid="usage-tab">
        <div className="flex items-center gap-3">
          <GaugeIcon className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm">
            Add a repo from the Credentials tab to start tracking API quota usage.
          </p>
        </div>
      </Card>
    )
  }

  const now = nowTick
  return (
    <div className="space-y-3" data-testid="usage-tab">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {state.lastRefreshAt
            ? `Updated ${formatReset({ limit: 1, used: 0, remaining: 1, reset: Math.floor(now / 1000) }, now)}`
            : "Loading…"}
        </p>
        <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCwIcon className={`h-4 w-4 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
      {repos.map((repo) => {
        const snap = state.byRepo.get(repo.fullName)
        const err = state.errors.get(repo.fullName)
        return (
          <Card key={repo.fullName} className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-mono text-sm">{repo.fullName}</p>
              <Badge variant="secondary">{repo.credentialMode}</Badge>
            </div>
            {err && <p className="text-xs text-destructive">{err}</p>}
            {snap && (
              <div className="grid grid-cols-3 gap-3">
                {(["core", "search", "graphql"] as const).map((k) => {
                  const b = snap[k]
                  return (
                    <div key={k}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="font-mono">
                          {b.remaining}/{b.limit}
                        </span>
                      </div>
                      <Progress value={percentRemaining(b)} />
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        resets {formatReset(b, now)}
                      </p>
                    </div>
                  )
                })}
              </div>
            )}
            {!snap && !err && <p className="text-xs text-muted-foreground">Loading…</p>}
          </Card>
        )
      })}
    </div>
  )
}
