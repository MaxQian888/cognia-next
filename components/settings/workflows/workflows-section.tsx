"use client"

/**
 * Settings → Workflows. 5-tab shell mirroring the existing Data and
 * Connections sections — `library` / `runs` / `templates` / `defaults`
 * / `audit`. Active tab is reflected in `?wfTab=`.
 *
 * The Library tab embeds the same `<WorkflowLibrary />` rendered at
 * `/workflows`, so the user can manage workflows without leaving the
 * Settings shell.
 */

import { useRouter, useSearchParams } from "next/navigation"
import {
  ListIcon,
  PlayCircleIcon,
  SparklesIcon,
  SettingsIcon,
  ScrollTextIcon,
  WorkflowIcon,
} from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WorkflowLibrary } from "@/components/workflow/library/workflow-library"
import { LibraryTab } from "./tabs/library-tab"
import { RunsTab } from "./tabs/runs-tab"
import { TemplatesTab } from "./tabs/templates-tab"
import { DefaultsTab } from "./tabs/defaults-tab"
import { AuditTab } from "./tabs/audit-tab"

const WF_TAB_PARAM = "wfTab"

export type WorkflowTabId = "library" | "runs" | "templates" | "defaults" | "audit"

const TAB_IDS: WorkflowTabId[] = ["library", "runs", "templates", "defaults", "audit"]

function isWorkflowTab(value: string | null): value is WorkflowTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function WorkflowsSection() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(WF_TAB_PARAM)
  const activeTab: WorkflowTabId = isWorkflowTab(requested) ? requested : "library"

  const onTabChange = (value: string) => {
    if (!isWorkflowTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(WF_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <WorkflowIcon className="size-4" />
          Workflows
        </Label>
        <p className="text-xs text-muted-foreground">
          Visual orchestration for characters, teams, skills, twins, and connectors.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="library" className="gap-1.5">
              <ListIcon className="size-3.5" />
              Library
            </TabsTrigger>
            <TabsTrigger value="runs" className="gap-1.5">
              <PlayCircleIcon className="size-3.5" />
              Runs
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-1.5">
              <SparklesIcon className="size-3.5" />
              Templates
            </TabsTrigger>
            <TabsTrigger value="defaults" className="gap-1.5">
              <SettingsIcon className="size-3.5" />
              Defaults
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5">
              <ScrollTextIcon className="size-3.5" />
              Audit
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="library" className="mt-4">
          <LibraryTab />
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <RunsTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="defaults" className="mt-4">
          <DefaultsTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// Re-export the embedded WorkflowLibrary so deep callers can use the same
// component shell from outside Settings (mirrors how DataSection consumers
// can pull bits of the data-section pieces directly).
export { WorkflowLibrary }
