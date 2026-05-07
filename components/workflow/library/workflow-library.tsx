"use client"

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { PlusIcon, SearchIcon, WorkflowIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { listWorkflowsByUpdated } from "@/lib/db/workflows"
import { WorkflowCard } from "./workflow-card"
import { WorkflowCreateDialog } from "./workflow-create-dialog"

export function WorkflowLibrary() {
  const workflows = useLiveQuery(() => listWorkflowsByUpdated(), [])
  const [query, setQuery] = useState("")
  const [createOpen, setCreateOpen] = useState(false)

  const filtered = useMemo(() => {
    if (!workflows) return undefined
    const q = query.trim().toLowerCase()
    if (!q) return workflows
    return workflows.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.description?.toLowerCase().includes(q) ||
        w.tags?.some((t) => t.toLowerCase().includes(q))
    )
  }, [workflows, query])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 py-4 border-b">
        <span className="rounded-md bg-primary/10 p-2 text-primary">
          <WorkflowIcon className="size-5" aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold leading-tight">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Visual orchestration for characters, teams, and connectors.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="workflow-create">
          <PlusIcon className="size-4 mr-1.5" />
          New workflow
        </Button>
      </header>
      <div className="px-6 py-3 border-b">
        <div className="relative max-w-md">
          <SearchIcon className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            className="pl-9"
            aria-label="Search workflows"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filtered === undefined ? (
          <LibrarySkeleton />
        ) : filtered.length === 0 ? (
          <Empty className="mx-auto max-w-md py-12">
            <EmptyHeader>
              <EmptyMedia>
                <WorkflowIcon className="size-8" aria-hidden="true" />
              </EmptyMedia>
            </EmptyHeader>
            <EmptyTitle>{query ? "No matching workflows" : "No workflows yet"}</EmptyTitle>
            <EmptyDescription>
              {query
                ? "Try a different search term, or clear the search to see all workflows."
                : "Create your first workflow to wire up triggers, agents, and connectors."}
            </EmptyDescription>
            {!query ? (
              <Button onClick={() => setCreateOpen(true)} className="mt-2">
                <PlusIcon className="size-4 mr-1.5" />
                Create workflow
              </Button>
            ) : null}
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((wf) => (
              <WorkflowCard key={wf.id} workflow={wf} />
            ))}
          </div>
        )}
      </div>
      <WorkflowCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-32 rounded-lg" />
      ))}
    </div>
  )
}
