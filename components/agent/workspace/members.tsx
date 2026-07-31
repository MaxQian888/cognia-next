"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { MoreHorizontalIcon, PlusIcon, Settings2Icon, Trash2Icon, UsersIcon } from "lucide-react"

import {
  MOBILE_SPRING,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "@/lib/ui/motion"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
import { RUNTIME_OPTIONS, runtimeLabelKey } from "./runtime-options"
import { TeammateConfigDialog } from "./teammate-config-dialog"

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
}

export function AgentTeamMembers({
  team,
  teammates,
  leadId,
  teamId: legacyTeamId,
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

  const [addOpen, setAddOpen] = useState(false)
  const [removing, setRemoving] = useState<AgentTeammate | null>(null)
  const [configuring, setConfiguring] = useState<AgentTeammate | null>(null)

  const lead = teammates.find((m) => m.id === leadId)
  const workers = teammates.filter((m) => m.role === "teammate")

  const handleAdd = (data: {
    name: string
    description: string
    role: "lead" | "teammate"
    specialization?: string
    runtime: TeammateRuntime
  }) => {
    const config: AgentTeammate["config"] = { runtime: data.runtime }
    if (data.specialization) config.specialization = data.specialization
    addTeammate({
      teamId,
      name: data.name.trim(),
      description: data.description.trim() || data.name.trim(),
      role: data.role,
      config,
    })
    toast.success(t("saved", { name: data.name.trim() }))
    setAddOpen(false)
  }

  const handleRuntimeChange = (member: AgentTeammate, runtime: TeammateRuntime) => {
    updateTeammate(member.id, {
      config: { ...member.config, runtime },
    })
    toast.success(t("runtimeUpdated", { name: member.name }))
  }

  const handleRemove = (m: AgentTeammate) => {
    removeTeammate(m.id)
    toast.success(t("removed", { name: m.name }))
    setRemoving(null)
  }

  if (teammates.length === 0) {
    return (
      <Empty className="mx-auto w-full max-w-lg">
        <EmptyMedia variant="icon">
          <UsersIcon />
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

  return (
    <div className="space-y-4" data-testid="workspace-members">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {t("title")} · {teammates.length}
        </p>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <PlusIcon className="mr-2 size-3.5" />
          {t("addMember")}
        </Button>
      </div>

      {/* Lead */}
      {lead && (
        <Card className="p-3" data-testid={`member-${lead.id}`}>
          <MemberRow
            member={lead}
            teamId={teamId}
            isLead
            onRemove={() => setRemoving(lead)}
            onConfigure={() => setConfiguring(lead)}
            onRuntimeChange={(r) => handleRuntimeChange(lead, r)}
          />
        </Card>
      )}

      {/* Workers */}
      {workers.length > 0 && (
        <motion.div
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 items-start"
          variants={STAGGER_CONTAINER}
          initial="initial"
          animate="animate"
        >
          <AnimatePresence initial={false}>
            {workers.map((m) => (
              <motion.div
                key={m.id}
                layout
                variants={childVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={layoutTransition}
              >
                <Card className="p-3" data-testid={`member-${m.id}`}>
                  <MemberRow
                    member={m}
                    teamId={teamId}
                    onRemove={() => setRemoving(m)}
                    onConfigure={() => setConfiguring(m)}
                    onRuntimeChange={(r) => handleRuntimeChange(m, r)}
                  />
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

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
  onRuntimeChange,
}: {
  member: AgentTeammate
  teamId: string
  isLead?: boolean
  onRemove: () => void
  onConfigure: () => void
  onRuntimeChange: (runtime: TeammateRuntime) => void
}) {
  const t = useTranslations("agentTeamsWorkspace.members")
  const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
  const statusCfg = TEAMMATE_STATUS_CONFIG[member.status]
  const runtime = member.config.runtime ?? DEFAULT_TEAMMATE_RUNTIME
  const prRow = useTeamPrStatusByTeammate(teamId).get(member.id)

  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-medium">
        {member.name.charAt(0).toUpperCase()}
      </span>
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
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{member.description}</p>
        )}
        {member.config?.specialization && (
          <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {member.config.specialization}
          </span>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Label className="text-[10px] text-muted-foreground">{t("runtime")}</Label>
          <Select value={runtime} onValueChange={(v) => onRuntimeChange(v as TeammateRuntime)}>
            <SelectTrigger
              className="h-7 w-full max-w-[12rem] text-xs sm:w-36"
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
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 shrink-0">
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onConfigure} data-testid={`configure-${member.id}`}>
            <Settings2Icon className="mr-2 size-3.5" />
            {t("configure")}
          </DropdownMenuItem>
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
    role: "lead" | "teammate"
    specialization?: string
    runtime: TeammateRuntime
  }) => void
}) {
  const t = useTranslations("agentTeamsWorkspace.members")
  const tRuntime = useTranslations("agentTeamsWorkspace.chat.runtime")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [role, setRole] = useState<"lead" | "teammate">("teammate")
  const [specialization, setSpecialization] = useState("")
  const [runtime, setRuntime] = useState<TeammateRuntime>(DEFAULT_TEAMMATE_RUNTIME)

  const submit = () => {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      description: description.trim(),
      role,
      specialization: specialization.trim() || undefined,
      runtime,
    })
    setName("")
    setDescription("")
    setRole("teammate")
    setSpecialization("")
    setRuntime(DEFAULT_TEAMMATE_RUNTIME)
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
            <Label className="text-xs">{t("role")}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">{t("lead")}</SelectItem>
                <SelectItem value="teammate">{t("teammate")}</SelectItem>
              </SelectContent>
            </Select>
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
            <Select value={runtime} onValueChange={(v) => setRuntime(v as TeammateRuntime)}>
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
