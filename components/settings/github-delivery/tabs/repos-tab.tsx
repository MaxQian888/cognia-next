"use client"

/**
 * Repos sub-tab. Lists configured repositories from the github-delivery
 * plugin's namespaced `github-delivery:repos` Dexie table. The plugin must
 * be enabled for data to appear; otherwise an empty-state card prompts the
 * user to install / enable it.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { GitBranchIcon, RefreshCwIcon, WebhookIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { getDb } from "@/lib/db/schema"
import type { GhRepoEntry } from "@/lib/github/types"
import type Dexie from "dexie"

const NAMESPACED_TABLE = "github-delivery:repos"

function getReposTable(): Dexie.Table<GhRepoEntry, string> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhRepoEntry, string>(NAMESPACED_TABLE)
  } catch {
    return null
  }
}

export function ReposTab() {
  const repos = useLiveQuery(async () => {
    const t = getReposTable()
    if (!t) return null
    try {
      return await t.toArray()
    } catch {
      return null
    }
  })

  if (repos === null) {
    return (
      <Card className="p-4 space-y-2" data-testid="repos-empty">
        <div className="flex items-center gap-2 text-muted-foreground">
          <GitBranchIcon className="h-4 w-4" />
          <span className="text-sm">The GitHub Delivery plugin is not enabled.</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Install or enable the plugin from Settings → Plugins → Marketplace, then return here.
        </p>
      </Card>
    )
  }

  if (repos === undefined) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading repos…</p>
      </Card>
    )
  }

  if (repos.length === 0) {
    return (
      <Card className="p-4 space-y-2" data-testid="repos-none">
        <p className="text-sm">No repos configured yet.</p>
        <p className="text-xs text-muted-foreground">
          Add a repo via the Setup Wizard (Credentials tab) to start receiving events.
        </p>
        <Button size="sm" data-testid="add-repo-cta">
          Add a repo
        </Button>
      </Card>
    )
  }

  return (
    <div className="space-y-3" data-testid="repos-list">
      {repos.map((repo) => (
        <Card key={repo.fullName} className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <GitBranchIcon className="h-4 w-4" />
                <p className="font-mono text-sm">{repo.fullName}</p>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <Badge variant="secondary">{repo.credentialMode === "app" ? "App" : "PAT"}</Badge>
                <Badge variant="outline" className="text-xs">
                  {repo.triggerMode === "webhook" ? (
                    <span className="flex items-center gap-1">
                      <WebhookIcon className="h-3 w-3" /> webhook
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <RefreshCwIcon className="h-3 w-3" /> polling
                    </span>
                  )}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  worktree: {repo.worktreeMode}
                </Badge>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              {repo.lastDeliveryAt
                ? new Date(repo.lastDeliveryAt).toLocaleString()
                : "no events yet"}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
