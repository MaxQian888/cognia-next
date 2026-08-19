"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { createSiteProject } from "@/lib/db/sites"
import type { Project } from "@/types"

export interface NewSiteDialogProps {
  projects: Project[]
  activeProjectId: string | null
  actorAccountId: string
  onCreated: (siteId: string) => void
}

/**
 * Site creation moved out of the cramped sidebar footer into a proper dialog.
 * Reuses `createSiteProject`; the source root is the selected project's primary
 * workspace root. On success it reports the new id so the shell can select it.
 *
 * The zone id is optional but collected here because `addDomain` refuses to run
 * without one, and nothing in the app could supply it — every custom domain
 * attempt threw for Sites created through this dialog.
 */
export function NewSiteDialog({
  projects,
  activeProjectId,
  actorAccountId,
  onCreated,
}: NewSiteDialogProps) {
  const t = useTranslations("sites")
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState(activeProjectId ?? "")
  const [siteName, setSiteName] = useState("")
  const [sourceSubpath, setSourceSubpath] = useState("")
  const [accountId, setAccountId] = useState("")
  const [workerName, setWorkerName] = useState("")
  const [zoneId, setZoneId] = useState("")
  const [accessTeamName, setAccessTeamName] = useState("")
  const [busy, setBusy] = useState(false)

  const effectiveProjectId = projectId || activeProjectId || projects[0]?.id || ""
  const project = projects.find((candidate) => candidate.id === effectiveProjectId) ?? projects[0]
  const sourceRoot = project?.roots.find((root) => root.isPrimary)?.path ?? project?.roots[0]?.path

  const create = async () => {
    if (!project || !sourceRoot) {
      toast.error(t("errors.projectRoot"))
      return
    }
    setBusy(true)
    try {
      const site = await createSiteProject({
        id: `site_${crypto.randomUUID()}`,
        name: siteName,
        projectId: project.id,
        sourceRoot,
        sourceSubpath,
        executionTarget: { kind: "local" },
        provider: "cloudflare",
        providerConfig: {
          accountId,
          workerName,
          ...(zoneId.trim() ? { zoneId: zoneId.trim() } : {}),
          ...(accessTeamName.trim() ? { accessTeamName: accessTeamName.trim() } : {}),
        },
        authoringPolicy: {
          ownerAccountId: actorAccountId,
          editorAccountIds: [],
          deployerAccountIds: [],
        },
        visitorPolicy: { mode: "private" },
      })
      onCreated(site.id)
      setSiteName("")
      setSourceSubpath("")
      setAccountId("")
      setWorkerName("")
      setZoneId("")
      setAccessTeamName("")
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="w-full" variant="outline">
          <PlusIcon className="size-4" />
          {t("actions.newSite")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <NativeSelect
            value={effectiveProjectId}
            onChange={(event) => setProjectId(event.target.value)}
            aria-label={t("create.project")}
          >
            {projects.map((candidate) => (
              <NativeSelectOption key={candidate.id} value={candidate.id}>
                {candidate.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            value={siteName}
            onChange={(event) => setSiteName(event.target.value)}
            placeholder={t("create.name")}
          />
          <Input
            value={sourceSubpath}
            onChange={(event) => setSourceSubpath(event.target.value)}
            placeholder={t("create.subpath")}
          />
          <Input
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            placeholder={t("create.accountId")}
          />
          <Input
            value={workerName}
            onChange={(event) => setWorkerName(event.target.value)}
            placeholder={t("create.workerName")}
          />
          <Input
            value={zoneId}
            onChange={(event) => setZoneId(event.target.value)}
            placeholder={t("provider.zoneId")}
            aria-label={t("provider.zoneId")}
          />
          <Input
            value={accessTeamName}
            onChange={(event) => setAccessTeamName(event.target.value)}
            placeholder={t("provider.accessTeamName")}
            aria-label={t("provider.accessTeamName")}
          />
        </div>
        <DialogFooter>
          <Button
            onClick={() => void create()}
            disabled={busy || !siteName || !accountId || !workerName}
          >
            {busy ? t("actions.creating") : t("actions.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
