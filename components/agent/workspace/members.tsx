"use client"

import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { CrownIcon, MoreHorizontalIcon, PlusIcon, Settings2Icon, Trash2Icon } from "lucide-react"

import {
  MOBILE_SPRING,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "@/lib/ui/motion"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { PrStatusBadge } from "./pr-status-badge"
import { useTeamPrStatusByTeammate } from "@/hooks/agent-runs/use-team-pr-status"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { toast } from "sonner"

import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { TEAMMATE_STATUS_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeam, AgentTeammate, TeammateRuntime } from "@/types/agent/agent-team"
import { DEFAULT_TEAMMATE_RUNTIME } from "@/types/agent/agent-team"
import { RuntimeBadge } from "./runtime-badge"
import {
  RUNTIME_OPTIONS,
  runtimeLabelKey,
  withTeammateConfigPin,
  withTeammateRuntime,
} from "./runtime-options"
import { ExternalAgentConfigPinField } from "@/components/agent/external-agent/external-agent-config-pin-field"
import { TeammateConfigDialog } from "./teammate-config-dialog"
import { AgentTeamAvatar } from "./agent-team-avatar"

export interface AgentTeamMembersProps {
  /**
   * Full team object — required for the new "Configure teammate" dialog
   * that needs `team.config.capabilities` to compute capability overlays.
   * Falls back to a minimal stub when only `teamId` is supplied (legacy
   * test fixtures); the configure affordance is disabled in that case.
   */
  team?: AgentTeam
  teammates: AgentTeammate[]
  leadId: string
  /** Legacy entry point: pass `team` instead. Kept for prop-back-compat. */
  teamId?: string
  /**
   * Controls the "Add teammate" dialog from outside. Settings passes these so
   * the readiness blocker that asks for a teammate can open the dialog in
   * place, instead of linking to the pane it is already on. Omit both to let
   * the roster own the dialog, which is every other host.
   */
  addOpen?: boolean
  onAddOpenChange?: (open: boolean) => void
}

export function AgentTeamMembers({
  team,
  teammates,
  leadId,
  teamId: legacyTeamId,
  addOpen: controlledAddOpen,
  onAddOpenChange,
}: AgentTeamMembersProps) {
  const teamId = team?.id ?? legacyTeamId ?? ""
  const t = useTranslations("agentTeamsWorkspace.members")
  // House motion tokens (`@/lib/ui/motion`) rather than the hand-rolled
  // `y:4 / 0.15s / easeOut` this file used to carry — the same idiom was copied
  // into four workspace panels and none of them matched the rest of the app.
  // `layout` + a spring is what makes a roster reflow when a member is removed
  // instead of the survivors jumping into the gap.
  const childVariants = useReducedMotionVariants(STAGGER_CHILD)
  const layoutTransition = useReducedMotionTransition(MOBILE_SPRING)
  const addTeammate = useAgentTeamStore((s) => s.addTeammate)
  const removeTeammate = useAgentTeamStore((s) => s.removeTeammate)
  const updateTeammate = useAgentTeamStore((s) => s.updateTeammate)

  const [ownAddOpen, setOwnAddOpen] = useState(false)
  const addOpen = controlledAddOpen ?? ownAddOpen
  const setAddOpen = (open: boolean) => {
    if (controlledAddOpen === undefined) setOwnAddOpen(open)
    onAddOpenChange?.(open)
  }
  const [removing, setRemoving] = useState<AgentTeammate | null>(null)
  const [configuring, setConfiguring] = useState<AgentTeammate | null>(null)

  const lead = teammates.find((m) => m.id === leadId)
  const workers = teammates.filter((m) => m.role === "teammate")

  const handleAdd = (data: {
    name: string
    description: string
    specialization?: string
    runtime: TeammateRuntime
    externalAgentConfigId?: string
  }) => {
    const config: AgentTeammate["config"] = { runtime: data.runtime }
    if (data.specialization) config.specialization = data.specialization
    if (data.runtime !== "claude" && data.externalAgentConfigId) {
      config.externalAgentConfigId = data.externalAgentConfigId
    }
    addTeammate({
      teamId,
      name: data.name.trim(),
      description: data.description.trim() || data.name.trim(),
      // Always a worker. The dialog used to offer "Lead" as well, but
      // `addTeammate` only appends to `teammateIds` and never moves
      // `team.leadId`, so a member added that way matched neither the lead
      // lookup (`id === leadId`) nor the worker filter (`role === "teammate"`)
      // and simply did not appear. Every Squad is created with exactly one
      // lead (`createTeam` seeds it), so there was nothing here to pick.
      role: "teammate",
      config,
    })
    toast.success(t("saved", { name: data.name.trim() }))
    setAddOpen(false)
  }

  const handleRuntimeChange = (member: AgentTeammate, runtime: TeammateRuntime) => {
    updateTeammate(member.id, {
      // A runtime switch drops the exact-config pin, which names a config of
      // the old runtime.
      config: withTeammateRuntime(member.config, runtime),
    })
    toast.success(t("runtimeUpdated", { name: member.name }))
  }

  const handleConfigPinChange = (member: AgentTeammate, configId: string | undefined) => {
    updateTeammate(member.id, {
      config: withTeammateConfigPin(member.config, configId),
    })
  }

  const setSquadLead = useAgentTeamStore((s) => s.setSquadLead)
  const teamStatus = useAgentTeamStore((s) => s.teams[teamId]?.status)
  // Mirrors the store's own refusal, so the menu says so before the click
  // rather than after it.
  const leadLocked =
    teamStatus === "planning" || teamStatus === "executing" || teamStatus === "paused"

  const handleMakeLead = (m: AgentTeammate) => {
    const result = setSquadLead(teamId, m.id)
    if (result.ok) {
      toast.success(t("leadChanged", { name: m.name }))
    } else if (result.reason === "run_active") {
      toast.error(t("leadLocked"))
    }
  }

  const handleRemove = (m: AgentTeammate) => {
    removeTeammate(m.id)
    toast.success(t("removed", { name: m.name }))
    setRemoving(null)
  }

  if (teammates.length === 0) {
    return (
      <Empty className="mx-auto w-full max-w-lg">
        <EmptyMedia>
          <MobileSpotIcon name="agent-teams" size={96} />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{t("empty")}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <PlusIcon className="mr-2 size-4" />
            {t("addMember")}
          </Button>
        </EmptyContent>
        <AddDialog open={addOpen} onOpenChange={setAddOpen} onSave={handleAdd} />
      </Empty>
    )
  }

  // One list, lead first, rows split by hairlines. Each member used to be its
  // own Card in a grid keyed to the WINDOW (`sm:grid-cols-2 xl:grid-cols-3`),
  // so inside Settings' ~500px detail pane on a wide monitor the grid laid
  // three cards into room for one and every runtime select was crushed. The
  // row now reflows off the roster's own width (`@container/roster`).
  const ordered = lead ? [lead, ...workers] : workers

  return (
    <div className="@container/roster space-y-2" data-testid="workspace-members">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground" data-testid="workspace-members-count">
          {t("count", { count: teammates.length })}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAddOpen(true)}
          data-testid="workspace-members-add"
        >
          <PlusIcon className="mr-2 size-3.5" />
          {t("addMember")}
        </Button>
      </div>

      <motion.ul
        className="divide-y divide-border/60"
        variants={STAGGER_CONTAINER}
        initial="initial"
        animate="animate"
      >
        <AnimatePresence initial={false}>
          {ordered.map((m) => {
            const isLead = m.id === leadId
            return (
              <motion.li
                key={m.id}
                layout
                variants={childVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={layoutTransition}
                className="py-3 first:pt-1"
                data-testid={`member-${m.id}`}
                data-role={isLead ? "lead" : "teammate"}
              >
                <MemberRow
                  member={m}
                  teamId={teamId}
                  isLead={isLead}
                  onRemove={() => setRemoving(m)}
                  onConfigure={() => setConfiguring(m)}
                  {...(isLead
                    ? {}
                    : { onMakeLead: () => handleMakeLead(m), makeLeadDisabled: leadLocked })}
                  onRuntimeChange={(r) => handleRuntimeChange(m, r)}
                  {...(isLead ? {} : { onConfigPinChange: (id) => handleConfigPinChange(m, id) })}
                />
              </motion.li>
            )
          })}
        </AnimatePresence>
      </motion.ul>

      {configuring && team ? (
        <TeammateConfigDialog
          open={!!configuring}
          onOpenChange={(open) => {
            if (!open) setConfiguring(null)
          }}
          teammate={configuring}
          team={team}
        />
      ) : null}

      <AddDialog open={addOpen} onOpenChange={setAddOpen} onSave={handleAdd} />

      <AlertDialog
        open={!!removing}
        onOpenChange={(o) => {
          if (!o) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeBody", { name: removing?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => removing && handleRemove(removing)}
            >
              {t("removeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Member Row                                                         */
/* ------------------------------------------------------------------ */

function MemberRow({
  member,
  teamId,
  isLead,
  onRemove,
  onConfigure,
  onMakeLead,
  makeLeadDisabled = false,
  onRuntimeChange,
  onConfigPinChange,
}: {
  member: AgentTeammate
  teamId: string
  isLead?: boolean
  onRemove: () => void
  onConfigure: () => void
  /** Hand this member the lead. Absent for the lead itself. */
  onMakeLead?: () => void
  /** A run is live or paused, so the lead is locked until it ends. */
  makeLeadDisabled?: boolean
  onRuntimeChange: (runtime: TeammateRuntime) => void
  /** Pin (or clear) the exact external-agent config. Absent for the lead. */
  onConfigPinChange?: (configId: string | undefined) => void
}) {
  const t = useTranslations("agentTeamsWorkspace.members")
  const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
  const statusCfg = TEAMMATE_STATUS_CONFIG[member.status]
  const runtime = member.config.runtime ?? DEFAULT_TEAMMATE_RUNTIME
  const prRow = useTeamPrStatusByTeammate(teamId).get(member.id)

  return (
    <div className="flex items-start gap-3">
      <AgentTeamAvatar
        subject={member}
        className="size-9 shrink-0 rounded-full bg-primary/10 ring-1 ring-inset ring-primary/10"
      />
      <div className="min-w-0 flex-1 @2xl/roster:flex @2xl/roster:items-start @2xl/roster:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium">{member.name}</p>
            <Badge variant={isLead ? "default" : "outline"} className="text-[10px]">
              {isLead ? t("lead") : t("teammate")}
            </Badge>
            {statusCfg && (
              <StatusBadge
                value={statusCfg.labelKey ?? member.status}
                labelNamespace="agentTeam.teammateStatus"
                pulse={member.status === "executing" || member.status === "planning"}
                className="text-[10px]"
                data-testid={`member-${member.id}-status`}
              />
            )}
            {prRow && <PrStatusBadge status={prRow.derivedStatus} prUrl={prRow.prUrl} />}
            <RuntimeBadge runtime={runtime} />
          </div>
          {member.description && (
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
              {member.description}
            </p>
          )}
          {member.config?.specialization && (
            <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {member.config.specialization}
            </span>
          )}
        </div>
        <div className="mt-2 shrink-0 space-y-1.5 @2xl/roster:mt-0 @2xl/roster:w-56">
          <div className="flex items-center gap-2">
            <Label className="text-[10px] text-muted-foreground">{t("runtime")}</Label>
            <Select value={runtime} onValueChange={(v) => onRuntimeChange(v as TeammateRuntime)}>
              <SelectTrigger
                className="h-7 w-full max-w-[12rem] text-xs"
                data-testid={`runtime-select-${member.id}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RUNTIME_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r} className="text-xs">
                    {tRuntime(runtimeLabelKey(r))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {onConfigPinChange && runtime !== "claude" ? (
            <ExternalAgentConfigPinField
              compact
              className="max-w-[16rem]"
              triggerClassName="h-7"
              presetId={runtime}
              presetLabel={tRuntime(runtimeLabelKey(runtime))}
              value={member.config.externalAgentConfigId}
              onChange={onConfigPinChange}
              data-testid={`config-pin-${member.id}`}
            />
          ) : null}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={t("actionsFor", { name: member.name })}
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onConfigure} data-testid={`configure-${member.id}`}>
            <Settings2Icon className="mr-2 size-3.5" />
            {t("configure")}
          </DropdownMenuItem>
          {onMakeLead ? (
            <DropdownMenuItem
              onClick={onMakeLead}
              disabled={makeLeadDisabled}
              className="flex-col items-start gap-0.5"
              data-testid={`make-lead-${member.id}`}
            >
              <span className="flex items-center">
                <CrownIcon className="mr-2 size-3.5" />
                {t("makeLead")}
              </span>
              {/* Said in the item, not a tooltip, which no touch screen shows. */}
              {makeLeadDisabled ? (
                <span className="pl-5.5 text-[11px] text-muted-foreground">
                  {t("leadLockedShort")}
                </span>
              ) : null}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {!isLead && (
            <DropdownMenuItem className="text-destructive" onClick={onRemove}>
              <Trash2Icon className="mr-2 size-3.5" />
              {t("removeAction")}
            </DropdownMenuItem>
          )}
          {/* Plugin-contributed teammate-scoped actions. */}
          <PluginExtensionSlot
            point="agent.teammate.actions"
            context={{
              teamId,
              teammateId: member.id,
              role: isLead ? "lead" : member.role,
              status: member.status,
              runtime: member.config.runtime ?? DEFAULT_TEAMMATE_RUNTIME,
              specialization: member.config?.specialization,
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Add Dialog                                                         */
/* ------------------------------------------------------------------ */

function AddDialog({
  open,
  onOpenChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: {
    name: string
    description: string
    specialization?: string
    runtime: TeammateRuntime
    externalAgentConfigId?: string
  }) => void
}) {
  const t = useTranslations("agentTeamsWorkspace.members")
  const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [specialization, setSpecialization] = useState("")
  const [runtime, setRuntime] = useState<TeammateRuntime>(DEFAULT_TEAMMATE_RUNTIME)
  const [configPin, setConfigPin] = useState<string | undefined>(undefined)

  const submit = () => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      description: description.trim(),
      specialization: specialization.trim() || undefined,
      runtime,
      ...(configPin ? { externalAgentConfigId: configPin } : {}),
    })
    setName("")
    setDescription("")
    setSpecialization("")
    setRuntime(DEFAULT_TEAMMATE_RUNTIME)
    setConfigPin(undefined)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("addMemberTitle")}</DialogTitle>
          <DialogDescription>{t("descriptionPlaceholder")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{t("name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("description")}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              className="text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("specialization")}</Label>
            <Input
              value={specialization}
              onChange={(e) => setSpecialization(e.target.value)}
              placeholder={t("specializationPlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("runtime")}</Label>
            <Select
              value={runtime}
              onValueChange={(v) => {
                // The pin names a config of the previous runtime.
                if (v !== runtime) setConfigPin(undefined)
                setRuntime(v as TeammateRuntime)
              }}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="runtime-select-add">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RUNTIME_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r} className="text-xs">
                    {tRuntime(runtimeLabelKey(r))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {runtime !== "claude" ? (
            <ExternalAgentConfigPinField
              presetId={runtime}
              presetLabel={tRuntime(runtimeLabelKey(runtime))}
              value={configPin}
              onChange={setConfigPin}
              data-testid="config-pin-add"
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
