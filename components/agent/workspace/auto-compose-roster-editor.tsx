"use client"

/**
 * Editable roster for the auto-compose preview.
 *
 * Field edits (name, description, specialization, capabilities) are applied
 * immutably and reported through `onChange`. Structural changes that move
 * roster indices — add, remove, promote-to-lead — are delegated to the dialog
 * via `onAdd` / `onRemove` / `onSetLead`, because they must also remap the task
 * graph's `assignedTo` references (see `lib/ai/agent/team/auto/edit-proposal`).
 *
 * Capabilities are offered ONLY from the live catalog, mirroring how the
 * compose stage emits overlays (`{ add: [...] }` per bucket), so the operator
 * can never assign a capability the runtime can't resolve.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, StarIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { CapabilityCatalog, ProposedTeammate } from "@/lib/ai/agent/team/auto/types"

const CAP_BUCKETS = [
  "skillIds",
  "mcpServerIds",
  "nativeAnthropicToolIds",
  "characterPackIds",
  "externalAgentPresetIds",
  "subagentIds",
] as const
type CapBucket = (typeof CAP_BUCKETS)[number]

function selectedIds(member: ProposedTeammate, bucket: CapBucket): string[] {
  const overlay = member.capabilities?.[bucket]
  return overlay?.add ?? overlay?.replace ?? []
}

/** Toggle one capability id for a member, normalizing the overlay to `add` lists. */
function toggleCapability(
  member: ProposedTeammate,
  bucket: CapBucket,
  id: string
): ProposedTeammate {
  const current = new Set(selectedIds(member, bucket))
  if (current.has(id)) current.delete(id)
  else current.add(id)
  const caps = { ...member.capabilities }
  if (current.size) caps[bucket] = { add: [...current] }
  else delete caps[bucket]
  return { ...member, capabilities: Object.keys(caps).length ? caps : undefined }
}

export interface AutoComposeRosterEditorProps {
  roster: ProposedTeammate[]
  catalog: CapabilityCatalog
  onChange: (roster: ProposedTeammate[]) => void
  onAdd: () => void
  onRemove: (index: number) => void
  onSetLead: (index: number) => void
}

export function AutoComposeRosterEditor({
  roster,
  catalog,
  onChange,
  onAdd,
  onRemove,
  onSetLead,
}: AutoComposeRosterEditorProps) {
  const t = useTranslations("agentTeamsWorkspace.autoCompose")
  const tBucket = useTranslations("agentTeamsWorkspace.autoCompose.capabilityBuckets")
  const activeBuckets = CAP_BUCKETS.filter((b) => catalog[b].length > 0)

  const patchMember = (index: number, patch: Partial<ProposedTeammate>) =>
    onChange(roster.map((m, i) => (i === index ? { ...m, ...patch } : m)))

  return (
    <div className="space-y-2" data-testid="auto-compose-roster-editor">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("rosterLabel", { count: roster.length })}</Label>
        <Button size="sm" variant="outline" onClick={onAdd} data-testid="auto-compose-add-member">
          <PlusIcon className="mr-1 size-3" />
          {t("addMember")}
        </Button>
      </div>

      <div className="space-y-2">
        {roster.map((member, i) => {
          const isLead = i === 0
          return (
            <div
              key={i}
              className="space-y-2 rounded-md border bg-muted/20 p-2.5"
              data-testid={`auto-compose-member-${i}`}
            >
              <div className="flex items-center gap-2">
                <Input
                  value={member.name}
                  onChange={(e) => patchMember(i, { name: e.target.value })}
                  placeholder={t("memberNamePlaceholder")}
                  className="h-7 flex-1 text-xs"
                  aria-label={t("memberNamePlaceholder")}
                  data-testid={`auto-compose-member-name-${i}`}
                />
                {isLead ? (
                  <Badge variant="secondary" className="text-[9px]">
                    {t("lead")}
                  </Badge>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    onClick={() => onSetLead(i)}
                    aria-label={t("makeLead")}
                    title={t("makeLead")}
                    data-testid={`auto-compose-set-lead-${i}`}
                  >
                    <StarIcon className="size-3.5" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-destructive"
                  onClick={() => onRemove(i)}
                  disabled={roster.length <= 1}
                  aria-label={t("removeMember")}
                  title={t("removeMember")}
                  data-testid={`auto-compose-remove-member-${i}`}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>

              <Input
                value={member.description}
                onChange={(e) => patchMember(i, { description: e.target.value })}
                placeholder={t("descriptionPlaceholder")}
                className="h-7 text-xs"
                aria-label={t("descriptionPlaceholder")}
                data-testid={`auto-compose-member-desc-${i}`}
              />

              <div className="flex items-center gap-2">
                <Label className="text-[10px] text-muted-foreground">
                  {t("specializationLabel")}
                </Label>
                <Input
                  value={member.specialization ?? ""}
                  onChange={(e) => patchMember(i, { specialization: e.target.value || undefined })}
                  placeholder={t("specializationPlaceholder")}
                  className="h-7 flex-1 text-xs"
                  aria-label={t("specializationLabel")}
                  data-testid={`auto-compose-member-spec-${i}`}
                />
              </div>

              {activeBuckets.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-[10px] text-muted-foreground">
                    {t("capabilitiesLabel")}
                  </Label>
                  {activeBuckets.map((bucket) => {
                    const selected = new Set(selectedIds(member, bucket))
                    return (
                      <div key={bucket} className="space-y-1">
                        <p className="text-[10px] text-muted-foreground/80">{tBucket(bucket)}</p>
                        <div className="flex flex-wrap gap-1">
                          {catalog[bucket].map((id) => {
                            const on = selected.has(id)
                            return (
                              <button
                                key={id}
                                type="button"
                                aria-pressed={on}
                                onClick={() =>
                                  onChange(
                                    roster.map((m, idx) =>
                                      idx === i ? toggleCapability(m, bucket, id) : m
                                    )
                                  )
                                }
                                className={cn(
                                  "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                                  on
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted"
                                )}
                                data-testid={`auto-compose-cap-${i}-${bucket}-${id}`}
                              >
                                {id}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
