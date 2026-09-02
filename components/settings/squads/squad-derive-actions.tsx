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
 *
 * Saving a template mirrors a platform DRAFT, and a draft is not shareable: a
 * package bundles published releases, `exportPackage` refuses anything else,
 * and `fork` measures against a release. So the dialog offers to publish in the
 * same step, through `getPublishSuggestion` and `PublishConfirmDialog` rather
 * than a version this component invents. `publish` refuses a `confirmedBump`
 * that does not match its own conservative suggestion, and returns the reasons,
 * precisely so a human sees why a change is major before it becomes major.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, LayoutTemplateIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  platformIdForSquadTemplate,
  publishSquadTemplateToPlatform,
} from "@/lib/agent-team/publish-template-to-platform"
import {
  PublishConfirmDialog,
  type PublishSuggestion,
} from "@/components/templates/publish-confirm-dialog"
import type { TemplateVersionBump } from "@/lib/templates/contracts"
import { getTemplateRuntime, type TemplateRuntime } from "@/lib/templates/runtime"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"

export interface SquadDeriveActionsProps {
  squadId: string
  /** Called with the new squad's id so a caller can follow the copy. */
  onDuplicated?: (squadId: string) => void
  /** Called after a template is saved or published, so a gallery can re-read. */
  onTemplateChanged?: () => void
  className?: string
  /** Injected in tests. Production resolves the singleton runtime. */
  runtime?: TemplateRuntime
}

export function SquadDeriveActions({
  squadId,
  onDuplicated,
  onTemplateChanged,
  className,
  runtime,
}: SquadDeriveActionsProps) {
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
  const [publishAfterSave, setPublishAfterSave] = useState(true)
  const [publishSuggestion, setPublishSuggestion] = useState<PublishSuggestion | null>(null)
  const [publishTarget, setPublishTarget] = useState<{
    definitionId: string
    revision: number
    name: string
  } | null>(null)
  const [busy, setBusy] = useState(false)

  if (!squad) return null

  const resolved = runtime ?? getTemplateRuntime()

  const fail = (error: unknown) =>
    setMessage(
      t("publishFailed", { error: error instanceof Error ? error.message : String(error) })
    )

  /**
   * Save, mirror, then ask for the version.
   *
   * The mirror is awaited rather than fired and forgotten, because
   * `getPublishSuggestion` and `publish` both read the draft it writes. The
   * previous caller's `void` was fine when nothing depended on the result.
   */
  const saveTemplate = async () => {
    const template = saveAsTemplate(squadId, name.trim())
    setTemplateOpen(false)
    if (!template) return
    await publishSquadTemplateToPlatform(template, resolved)
    setMessage(t("templateSaved", { name: template.name }))
    onTemplateChanged?.()
    if (!publishAfterSave) return
    const definitionId = platformIdForSquadTemplate(template)
    const draft = await resolved.repository.getDraft(definitionId)
    if (!draft) return
    const suggestion = await resolved.service.getPublishSuggestion(definitionId)
    setPublishTarget({ definitionId, revision: draft.revision, name: template.name })
    setPublishSuggestion({ ...suggestion, bump: suggestion.bump as TemplateVersionBump })
  }

  const confirmPublish = async (bump: TemplateVersionBump) => {
    if (!publishTarget) return
    const published = await resolved.service.publish(publishTarget.definitionId, {
      expectedRevision: publishTarget.revision,
      confirmedBump: bump,
    })
    setPublishSuggestion(null)
    setPublishTarget(null)
    setMessage(t("templatePublished", { name: publishTarget.name, version: published.version }))
    onTemplateChanged?.()
  }

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
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="squad-template-name">{t("nameLabel")}</Label>
              <Input
                id="squad-template-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {/* A saved template is a DRAFT in the platform, and a draft cannot
                be packaged, forked from, or handed to anyone. Offering the
                release in the same step is what makes "save as template" mean
                what a user expects it to mean. */}
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={publishAfterSave}
                onCheckedChange={(value) => setPublishAfterSave(value === true)}
                data-testid="squad-template-publish-toggle"
                aria-label={t("publishOption")}
              />
              <span>
                <span className="block font-medium">{t("publishOption")}</span>
                <span className="block text-muted-foreground">{t("publishOptionHint")}</span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={!name.trim() || busy}
              data-testid="squad-save-as-template-confirm"
              onClick={() => {
                setBusy(true)
                void saveTemplate()
                  .catch(fail)
                  .finally(() => setBusy(false))
              }}
            >
              {t("saveAsTemplate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* `publish` refuses a bump that does not match its own suggestion and
          says why, so the dialog shows the version and the reasons rather than
          this component answering the check on the user's behalf. */}
      <PublishConfirmDialog
        suggestion={publishSuggestion}
        busy={busy}
        onOpenChange={(open) => {
          if (open) return
          setPublishSuggestion(null)
          setPublishTarget(null)
        }}
        onConfirm={(bump) => {
          setBusy(true)
          void confirmPublish(bump)
            .catch(fail)
            .finally(() => setBusy(false))
        }}
      />
    </section>
  )
}
