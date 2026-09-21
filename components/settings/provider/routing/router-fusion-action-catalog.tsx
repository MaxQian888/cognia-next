"use client"

// The Router + Fusion action catalog editor (ADR-0188 D17, B3): what each
// action runs — the model tier behind every role, how its answer is checked,
// its run cap, and for a panel its size and web evidence — plus actions of the
// user's own. Every change gives the action a new configuration hash, shown on
// its row; a run keeps the hash it was routed under.
//
// Nothing here can save a catalog that would not compile: every edit is checked
// by the package's own validators first, and a rejected edit is explained
// instead of saved.
//
// Every execution mode this build offers — direct, cascade, panel and, since
// B4, delegate — is editable here; delegate's sandbox and acceptance checks
// landed with it, so it is no longer labelled "later release". The dormancy
// mechanism below stays for the next mode or verifier profile a release
// declares before it wires it: an action whose mode is not in
// `EDITABLE_ACTION_MODES` is shown, labelled and not editable, and one whose
// verifier profile its mode cannot run is marked "not chosen" (Rule 7).

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { ROLE_CLASS_ALIASES } from "@cognia/router-fusion/config/builtin-catalog"
import type { ActionConfig, ExecutionMode } from "@cognia/router-fusion/contracts/schemas"
import {
  actionConfigHash,
  actionExtensionFor,
  builtinAction,
  draftActionFor,
  EDITABLE_ACTION_MODES,
  EDITABLE_PROFILES_BY_MODE,
  isBuiltinActionId,
  listFusionActions,
  rolesOf,
  validateActionDraft,
  validateOverride,
  withActionOverride,
  withCustomAction,
  withoutActionOverride,
  withoutCustomAction,
  type ActionDraftIssue,
} from "@cognia/router-fusion/settings/action-catalog"
import type { ActionOverride, RouterFusionSettings } from "@cognia/router-fusion/settings/settings"

import { KNOWN_PROFILES, KNOWN_ROLES } from "@/components/router-fusion/fusion-run-details"

import { RouterFusionUsdField } from "./router-fusion-usd-field"

type Patch =
  Partial<RouterFusionSettings> | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)

export interface RouterFusionActionCatalogProps {
  settings: RouterFusionSettings
  /** The model-mapping aliases a role may name. */
  aliases: readonly string[]
  persist: (patch: Patch) => void
}

const ALL_MODES: readonly ExecutionMode[] = ["direct", "cascade", "panel", "delegate"]
const UNUSED = "__unused__"

/** The action as it is without any override: the built-in, or the user's own as saved. */
function baseActionOf(settings: RouterFusionSettings, id: string): ActionConfig | undefined {
  return builtinAction(id) ?? settings.customActions.find((action) => action.id === id)
}

function useIssueText() {
  const t = useTranslations("routerFusion.settings.actions")
  const tRole = useTranslations("routerFusion.runCard.fusion.role")
  return (issue: ActionDraftIssue) => {
    if (!("role" in issue)) return t(`issue.${issue.code}` as never)
    const role = KNOWN_ROLES.has(issue.role) ? tRole(issue.role as never) : issue.role
    // Every role issue's sentence takes the same `{role}` value.
    return t(`issue.${issue.code}` as "issue.ROLE_MISSING", { role })
  }
}

function ActionEditor({
  action,
  settings,
  aliases,
  persist,
}: {
  action: ActionConfig
  settings: RouterFusionSettings
  aliases: readonly string[]
  persist: (patch: Patch) => void
}) {
  const t = useTranslations("routerFusion.settings.actions")
  const tRole = useTranslations("routerFusion.runCard.fusion.role")
  const tMode = useTranslations("routerFusion.modePicker")
  const issueText = useIssueText()
  const override = settings.actionOverrides[action.id]
  const extension = actionExtensionFor(action, settings)
  const custom = !isBuiltinActionId(action.id)
  const { required, optional } = rolesOf(action.mode)
  const modeCap = settings.runCapUsdByMode[action.mode]
  const profiles = EDITABLE_PROFILES_BY_MODE[action.mode]
  const aliasChoices = useMemo(
    () =>
      [
        ...new Set([
          ...aliases,
          ...Object.values(ROLE_CLASS_ALIASES),
          ...Object.values(action.roles),
        ]),
      ].sort(),
    [aliases, action.roles]
  )

  /**
   * Apply one edit to the action's override, read from what is saved now. An
   * edit the package's validator rejects is explained and not saved.
   */
  const edit = (change: (own: ActionOverride) => ActionOverride) =>
    persist((current) => {
      const base = baseActionOf(current, action.id)
      if (!base) return {}
      const own = current.actionOverrides[action.id] ?? {}
      const next = change(own)
      // `withActionOverride` merges; a field the change removed is removed here.
      const cleared = {
        ...current,
        actionOverrides: { ...current.actionOverrides, [action.id]: {} },
      }
      const overrides = withActionOverride(cleared, action.id, next)
      const issues = validateOverride(base, overrides[action.id] ?? {})
      if (issues.length > 0) {
        toast.error(t("saveRefused", { reason: issues.map(issueText).join(" ") }))
        return {}
      }
      return { actionOverrides: overrides }
    })

  const setRole = (role: string, alias: string) =>
    edit((own) => ({ ...own, roles: { ...(own.roles ?? {}), [role]: alias } }))
  const clearRole = (role: string) =>
    edit((own) => {
      const roles = { ...(own.roles ?? {}) }
      delete roles[role]
      return { ...own, roles }
    })
  const baseRoles = baseActionOf(settings, action.id)?.roles ?? {}

  const roleRow = (role: string, isRequired: boolean) => {
    const id = `router-fusion-action-${action.id}-role-${role}`
    const value = action.roles[role]
    const label = KNOWN_ROLES.has(role) ? tRole(role as never) : role
    // An override adds or replaces roles; one the action itself names stays.
    const removable = !isRequired && !(role in baseRoles)
    return (
      <div key={role} className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-xs font-normal">
          {label}
        </Label>
        <Select
          value={value ?? UNUSED}
          onValueChange={(next) => (next === UNUSED ? clearRole(role) : setRole(role, next))}
        >
          <SelectTrigger id={id} className="h-7 w-44 text-xs" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {isRequired ? null : (
              <SelectItem value={UNUSED} disabled={value !== undefined && !removable}>
                {t("roleUnused")}
              </SelectItem>
            )}
            {aliasChoices.map((alias) => (
              <SelectItem key={alias} value={alias}>
                <span className="font-mono">{alias}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  return (
    <div
      className="space-y-3 border-t px-3 py-3"
      data-testid={`router-fusion-action-editor-${action.id}`}
    >
      <div className="space-y-1.5">
        <p className="text-xs font-medium">{t("roles")}</p>
        <p className="text-[11px] text-muted-foreground">{t("rolesDesc")}</p>
        {required.map((role) => roleRow(role, true))}
        {optional.map((role) => roleRow(role, false))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={`router-fusion-action-${action.id}-profile`}>
            {t("profile")}
          </Label>
          <Select
            value={action.verifier_profile}
            onValueChange={(next) => edit((own) => ({ ...own, verifier_profile: next }))}
          >
            <SelectTrigger
              id={`router-fusion-action-${action.id}-profile`}
              className="h-8 w-48 text-xs"
              aria-label={t("profile")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...profiles, action.verifier_profile])].map((profile) => {
                const offered = (profiles as readonly string[]).includes(profile)
                return (
                  <SelectItem key={profile} value={profile} disabled={!offered}>
                    {KNOWN_PROFILES.has(profile) ? t(`profileValue.${profile}` as never) : profile}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {(profiles as readonly string[]).includes(action.verifier_profile)
              ? t(`profileDesc.${action.verifier_profile}` as never)
              : t("profileDormant")}
          </p>
        </div>

        <RouterFusionUsdField
          id={`router-fusion-action-${action.id}-cap`}
          label={t("runCap")}
          description={t("runCapDesc", { mode: tMode(action.mode as never), cap: modeCap })}
          value={override?.runCapUsd ?? ""}
          placeholder={modeCap}
          allowBlank
          onCommit={(next) =>
            edit((own) => {
              const { runCapUsd: _previous, ...rest } = own
              return next === "" ? rest : { ...rest, runCapUsd: next }
            })
          }
        />

        {action.mode === "panel" ? (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor={`router-fusion-action-${action.id}-panel-size`}>
                {t("panelSize")}
              </Label>
              <Select
                value={String(extension.limits.panel_size)}
                onValueChange={(next) =>
                  edit((own) => ({
                    ...own,
                    limits: { ...(own.limits ?? {}), panel_size: Number(next) },
                  }))
                }
              >
                <SelectTrigger
                  id={`router-fusion-action-${action.id}-panel-size`}
                  className="h-8 w-24 text-xs"
                  aria-label={t("panelSize")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{t("panelSizeDesc")}</p>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <Label className="text-xs" htmlFor={`router-fusion-action-${action.id}-web`}>
                  {t("webTools")}
                </Label>
                <p className="text-[11px] text-muted-foreground">{t("webToolsDesc")}</p>
              </div>
              <Switch
                id={`router-fusion-action-${action.id}-web`}
                checked={extension.web_tools_enabled}
                onCheckedChange={(on) => edit((own) => ({ ...own, webToolsEnabled: on }))}
                aria-label={t("webTools")}
              />
            </div>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="font-mono text-[10px] text-muted-foreground"
          data-testid={`router-fusion-action-hash-${action.id}`}
        >
          {t("hash", { hash: actionConfigHash(action, extension).slice(0, 12) })}
        </span>
        <div className="flex gap-1.5">
          {override ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() =>
                persist((current) => ({
                  actionOverrides: withoutActionOverride(current, action.id),
                }))
              }
            >
              <RotateCcw className="size-3" aria-hidden />
              {custom ? t("resetCustom") : t("reset")}
            </Button>
          ) : null}
          {custom ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs text-destructive"
              onClick={() => persist((current) => withoutCustomAction(current, action.id))}
            >
              <Trash2 className="size-3" aria-hidden />
              {t("delete")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AddActionForm({
  settings,
  persist,
}: {
  settings: RouterFusionSettings
  persist: (patch: Patch) => void
}) {
  const t = useTranslations("routerFusion.settings.actions")
  const tMode = useTranslations("routerFusion.modePicker")
  const issueText = useIssueText()
  const [id, setId] = useState("")
  const [mode, setMode] = useState<ExecutionMode>("cascade")
  const draft = draftActionFor(mode, id.trim())
  const issues =
    id.trim() === ""
      ? []
      : validateActionDraft(
          draft,
          settings.customActions.map((action) => action.id)
        )

  const add = () => {
    const found = validateActionDraft(
      draft,
      settings.customActions.map((action) => action.id)
    )
    if (found.length > 0) return
    persist((current) => {
      // Checked again against what is saved now, not what was rendered.
      if (
        validateActionDraft(
          draft,
          current.customActions.map((action) => action.id)
        ).length > 0
      )
        return {}
      return { customActions: withCustomAction(current, draft) }
    })
    toast.success(t("add.added", { id: draft.id }))
    setId("")
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-dashed px-3 py-2"
      data-testid="router-fusion-action-add"
    >
      <p className="text-xs font-medium">{t("add.title")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]" htmlFor="router-fusion-action-add-id">
            {t("add.id")}
          </Label>
          <Input
            id="router-fusion-action-add-id"
            value={id}
            onChange={(event) => setId(event.target.value)}
            aria-invalid={issues.length > 0}
            aria-describedby="router-fusion-action-add-desc"
            className="h-8 w-48 font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]" htmlFor="router-fusion-action-add-mode">
            {t("add.mode")}
          </Label>
          <Select value={mode} onValueChange={(next) => setMode(next as ExecutionMode)}>
            <SelectTrigger
              id="router-fusion-action-add-mode"
              className="h-8 w-32 text-xs"
              aria-label={t("add.mode")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_MODES.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  disabled={!EDITABLE_ACTION_MODES.includes(option)}
                >
                  {option === "delegate" ? t("mode.delegate") : tMode(option as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1 text-xs"
          disabled={id.trim() === "" || issues.length > 0}
          onClick={add}
        >
          <Plus className="size-3" aria-hidden />
          {t("add.submit")}
        </Button>
      </div>
      <p
        id="router-fusion-action-add-desc"
        className={cn(
          "text-[11px]",
          issues.length > 0 ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {issues.length > 0 ? issues.map(issueText).join(" ") : t("add.idDesc")}
      </p>
    </div>
  )
}

export function RouterFusionActionCatalog({
  settings,
  aliases,
  persist,
}: RouterFusionActionCatalogProps) {
  const t = useTranslations("routerFusion.settings.actions")
  const tRole = useTranslations("routerFusion.runCard.fusion.role")
  const tSettings = useTranslations("routerFusion.settings")
  const tMode = useTranslations("routerFusion.modePicker")
  const [open, setOpen] = useState<string | null>(null)
  const actions = listFusionActions(settings)

  return (
    <section
      className="space-y-2"
      aria-labelledby="router-fusion-actions"
      data-testid="router-fusion-actions"
    >
      <div>
        <h4 id="router-fusion-actions" className="text-xs font-medium">
          {t("title")}
        </h4>
        <p className="text-[11px] text-muted-foreground">{t("desc")}</p>
      </div>
      <ul className="space-y-1.5">
        {actions.map((action) => {
          const dormant = !EDITABLE_ACTION_MODES.includes(action.mode)
          // The router does not choose an action whose check cannot run yet.
          const checkDormant =
            !dormant &&
            !(EDITABLE_PROFILES_BY_MODE[action.mode] as readonly string[]).includes(
              action.verifier_profile
            )
          const custom = !isBuiltinActionId(action.id)
          const edited = Boolean(settings.actionOverrides[action.id])
          const expanded = open === action.id && !dormant
          return (
            <li
              key={action.id}
              className="rounded-lg border"
              data-testid={`router-fusion-action-${action.id}`}
              data-dormant={dormant ? "true" : undefined}
            >
              <Collapsible
                open={expanded}
                onOpenChange={(next) => setOpen(next ? action.id : null)}
              >
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs">{action.id}</span>
                      <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                        {action.mode === "delegate"
                          ? t("mode.delegate")
                          : tMode(action.mode as never)}
                      </Badge>
                      <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                        {custom ? t("custom") : t("builtin")}
                      </Badge>
                      {edited ? (
                        <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                          {t("edited")}
                        </Badge>
                      ) : null}
                      {dormant ? (
                        <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                          {tSettings("laterRelease")}
                        </Badge>
                      ) : null}
                      {checkDormant ? (
                        <Badge
                          variant="secondary"
                          className="h-4 px-1 text-[10px] font-normal"
                          title={t("profileDormant")}
                          data-testid={`router-fusion-action-check-dormant-${action.id}`}
                        >
                          {t("notChosen")}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {/* The generic dormancy sentence, not delegate's own:
                          delegate is wired since B4, and the next mode this
                          branch describes will not be it. */}
                      {dormant
                        ? tSettings("laterReleaseDesc")
                        : Object.entries(action.roles)
                            .map(
                              ([role, alias]) =>
                                `${KNOWN_ROLES.has(role) ? tRole(role as never) : role}: ${alias}`
                            )
                            .join(" · ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      checked={!dormant && action.enabled}
                      disabled={dormant}
                      onCheckedChange={(on) =>
                        persist((current) => {
                          const base = baseActionOf(current, action.id)
                          if (!base) return {}
                          return {
                            actionOverrides: withActionOverride(current, action.id, {
                              enabled: on,
                            }),
                          }
                        })
                      }
                      aria-label={t("enabled", { id: action.id })}
                    />
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        disabled={dormant}
                        aria-label={t("edit", { id: action.id })}
                        data-testid={`router-fusion-action-toggle-${action.id}`}
                      >
                        <ChevronDown
                          className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
                          aria-hidden
                        />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                </div>
                <CollapsibleContent>
                  {expanded ? (
                    <ActionEditor
                      action={action}
                      settings={settings}
                      aliases={aliases}
                      persist={persist}
                    />
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            </li>
          )
        })}
      </ul>
      <AddActionForm settings={settings} persist={persist} />
    </section>
  )
}
