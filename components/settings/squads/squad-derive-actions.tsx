"use client"

/**
 * Turning one squad into another: copy it, or save it as a reusable template.
 *
 * Both directions existed in the store and neither had a caller.
 * `saveAsTemplate` had none at all, so the only way to get a template was to
 * start from a built-in. There was no squad-to-squad copy whatsoever, which
 * made "this squad, but for the other repo" a retype.
 *
 * The copy takes a workspace because `AgentTeam.projectId` is a real Dexie
 * boundary from schema v215 rather than a filter over one shared bucket, so
 * copying into another workspace genuinely moves the squad there.
 *
 * Its own component rather than more rows in the detail panel: the phone shows
 * these next to the roster, where the panel's governance sections have no place.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, LayoutTemplateIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { publishSquadTemplateToPlatform } from "@/lib/agent-team/publish-template-to-platform"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"

export interface SquadDeriveActionsProps {
  squadId: string
  /** Called with the new squad's id so a caller can follow the copy. */
  onDuplicated?: (squadId: string) => void
  className?: string
}

export function SquadDeriveActions({ squadId, onDuplicated, className }: SquadDeriveActionsProps) {
  const t = useTranslations("settings.squads.derive")
  const squad = useAgentTeamStore((s) => s.teams[squadId])
  const duplicateSquad = useAgentTeamStore((s) => s.duplicateSquad)
  const saveAsTemplate = useAgentTeamStore((s) => s.saveAsTemplate)
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  const [copyOpen, setCopyOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [name, setName] = useState("")
  const [targetWorkspace, setTargetWorkspace] = useState<string>("")
  const [message, setMessage] = useState<string>()

  if (!squad) return null

  const openCopy = () => {
    setName(t("copyDefaultName", { name: squad.name }))
    setTargetWorkspace(squad.projectId ?? activeProjectId ?? "")
    setMessage(undefined)
    setCopyOpen(true)
  }

  const openTemplate = () => {
    setName(squad.name)
    setMessage(undefined)
    setTemplateOpen(true)
  }

  return (
    <section className={className} data-testid="squad-derive">
      <p className="text-xs font-medium">{t("title")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("description")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={openCopy} data-testid="squad-duplicate">
          <CopyIcon className="mr-1.5 size-3.5" />
          {t("duplicate")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={openTemplate}
          data-testid="squad-save-as-template"
        >
          <LayoutTemplateIcon className="mr-1.5 size-3.5" />
          {t("saveAsTemplate")}
        </Button>
      </div>
      {message ? (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="squad-derive-message">
          {message}
        </p>
      ) : null}

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent data-testid="squad-duplicate-dialog">
          <DialogHeader>
            <DialogTitle>{t("duplicateTitle")}</DialogTitle>
            <DialogDescription>{t("duplicateBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="squad-copy-name">{t("nameLabel")}</Label>
              <Input
                id="squad-copy-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="squad-copy-workspace">{t("workspaceLabel")}</Label>
              <Select value={targetWorkspace} onValueChange={setTargetWorkspace}>
                <SelectTrigger id="squad-copy-workspace" data-testid="squad-copy-workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!name.trim()}
              data-testid="squad-duplicate-confirm"
              onClick={() => {
                const copy = duplicateSquad(squadId, {
                  name: name.trim(),
                  ...(targetWorkspace ? { projectId: targetWorkspace } : {}),
                })
                setCopyOpen(false)
                if (!copy) return
                setMessage(t("duplicated", { name: copy.name }))
                onDuplicated?.(copy.id)
              }}
            >
              {t("duplicate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent data-testid="squad-template-dialog">
          <DialogHeader>
            <DialogTitle>{t("templateTitle")}</DialogTitle>
            {/* Says what a template deliberately drops. A user who expected a
                full copy and got a roster sketch would reasonably call that a
                bug, so the difference is stated before the button, not after. */}
            <DialogDescription>{t("templateBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="squad-template-name">{t("nameLabel")}</Label>
            <Input
              id="squad-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!name.trim()}
              data-testid="squad-save-as-template-confirm"
              onClick={() => {
                const template = saveAsTemplate(squadId, name.trim())
                setTemplateOpen(false)
                if (!template) return
                // Also into the unified platform, so the template is forkable,
                // exportable and findable right away rather than after the next
                // boot, which is when the migration used to project it.
                void publishSquadTemplateToPlatform(template)
                setMessage(t("templateSaved", { name: template.name }))
              }}
            >
              {t("saveAsTemplate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
