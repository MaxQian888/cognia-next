"use client"

/**
 * The desktop host's `quick` glance module: the user's own tray panel actions
 * (`lib/tray-panel/`), every one except the primary, which is the delegate bar.
 *
 * `compact` is an icon row, `standard` a list. An action with inputs opens its
 * form in place in both, and runs from there, exactly as the list always did;
 * an action without inputs runs on click. The catalogue is edited in Settings ›
 * Desktop, which the module links to.
 *
 * The catalogue arrives with the glance snapshot; `null` means it has not yet,
 * which reads as loading rather than as "you have no actions".
 */

import { createContext, useContext, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon } from "lucide-react"

import { useGlance } from "@/components/glance/glance-context"
import { GlanceLinkButton, GlanceSection } from "@/components/glance/glance-primitives"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { resolveLabel } from "@/lib/tray-panel/defaults"
import type { TrayPanelAction } from "@/lib/tray-panel/types"
import { cn } from "@/lib/utils"
import type { GlanceModuleSize } from "@/types/glance/layout"

import { TrayPanelFieldControl } from "./tray-panel-field-control"
import { useTrayPanelRunner } from "./tray-panel-runner"

const ActionsContext = createContext<readonly TrayPanelAction[] | null>(null)

export function TrayPanelQuickActionsProvider({
  actions,
  children,
}: {
  actions: readonly TrayPanelAction[] | null
  children: ReactNode
}) {
  return <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
}

function ActionForm({ action }: { action: TrayPanelAction }) {
  const t = useTranslations("trayPanel")
  const runner = useTrayPanelRunner()
  const values = runner.valuesFor(action.id)
  const invalid = runner.invalidFields(action.id)
  const error = runner.errorMessage(action.id)
  return (
    <div className="mt-1 space-y-2.5 rounded-md bg-muted/50 px-2.5 py-2.5">
      {action.fields.map((field) => (
        <TrayPanelFieldControl
          key={field.id}
          field={field}
          value={values[field.id]}
          invalid={invalid.has(field.id)}
          onChange={(next) => runner.setFieldValue(action.id, field.id, next)}
          onSubmit={() => void runner.run(action)}
        />
      ))}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        size="sm"
        variant="secondary"
        className="h-7 w-full text-xs"
        disabled={runner.busyId === action.id}
        onClick={() => void runner.run(action)}
      >
        {t("run")}
      </Button>
    </div>
  )
}

export function TrayPanelQuickActions({ size }: { size: GlanceModuleSize }) {
  const t = useTranslations("trayPanel")
  const tRoot = useTranslations()
  const actions = useContext(ActionsContext)
  const runner = useTrayPanelRunner()
  const { route } = useGlance()
  const title = t("quick.label")

  const activate = (action: TrayPanelAction) => {
    if (action.fields.length > 0) {
      runner.setExpandedId(runner.expandedId === action.id ? null : action.id)
      return
    }
    void runner.run(action)
  }
  const expanded = actions?.find((a) => a.id === runner.expandedId && a.fields.length > 0)
  const editLink = (
    <GlanceLinkButton onClick={() => route({ kind: "open-owner", owner: "tray-actions" })}>
      {t("quick.edit")}
    </GlanceLinkButton>
  )

  if (actions === null) {
    return (
      <GlanceSection moduleId="quick" title={title}>
        <p className="py-1 text-[12px] text-muted-foreground">{t("quick.loading")}</p>
      </GlanceSection>
    )
  }

  if (actions.length === 0) {
    return (
      <GlanceSection moduleId="quick" title={title} aside={editLink}>
        <p className="py-1 text-[12px] text-muted-foreground">{t("empty")}</p>
      </GlanceSection>
    )
  }

  if (size === "compact") {
    return (
      <section
        data-glance-module="quick"
        aria-label={title}
        className="@container/quick px-3.5 py-1"
      >
        <div className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 @min-[400px]/quick:grid-cols-[3rem_minmax(0,1fr)_auto]">
          <span className="w-12 shrink-0 text-[11.5px] font-semibold text-muted-foreground">
            {title}
          </span>
          <div
            role="toolbar"
            aria-label={title}
            className="order-last col-span-2 flex min-w-0 flex-wrap gap-0.5 @min-[400px]/quick:order-none @min-[400px]/quick:col-span-1"
            data-testid="tray-panel-actions"
          >
            {actions.map((action) => {
              const Icon = resolveIcon(action.icon)
              const label = resolveLabel(action, (key) => tRoot(key))
              return (
                <Tooltip key={action.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-glance-nav
                      data-testid={`tray-panel-action-${action.id}`}
                      aria-label={label}
                      aria-expanded={
                        action.fields.length > 0 ? runner.expandedId === action.id : undefined
                      }
                      onClick={() => activate(action)}
                      className={cn(
                        "inline-grid size-8 place-items-center rounded-md text-muted-foreground transition-colors",
                        "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none",
                        runner.expandedId === action.id && "bg-accent text-foreground",
                        runner.busyId === action.id && "opacity-60"
                      )}
                    >
                      {Icon ? (
                        <Icon className="size-4" />
                      ) : (
                        <span className="text-[11px]">{label.slice(0, 2)}</span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {label}
                    {action.trigger.kind === "hotkey" ? ` · ${action.trigger.chord}` : ""}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </div>
          {editLink}
        </div>
        {expanded ? <ActionForm action={expanded} /> : null}
      </section>
    )
  }

  return (
    <GlanceSection moduleId="quick" title={title} aside={editLink}>
      <div className="flex flex-col" data-testid="tray-panel-actions">
        {actions.map((action) => {
          const Icon = resolveIcon(action.icon)
          const isExpanded = runner.expandedId === action.id
          const hasFields = action.fields.length > 0
          return (
            <div key={action.id} className="min-w-0">
              <button
                type="button"
                data-glance-nav
                data-glance-expand={hasFields ? action.id : undefined}
                data-testid={`tray-panel-action-${action.id}`}
                aria-expanded={hasFields ? isExpanded : undefined}
                className={cn(
                  "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px]",
                  "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                  runner.busyId === action.id && "opacity-60"
                )}
                onClick={() => activate(action)}
              >
                {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                <span className="min-w-0 flex-1 truncate">
                  {resolveLabel(action, (key) => tRoot(key))}
                </span>
                {action.trigger.kind === "hotkey" ? (
                  <kbd className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                    {action.trigger.chord}
                  </kbd>
                ) : null}
                {hasFields ? (
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      isExpanded && "rotate-90"
                    )}
                  />
                ) : null}
              </button>
              {hasFields && isExpanded ? <ActionForm action={action} /> : null}
            </div>
          )
        })}
      </div>
    </GlanceSection>
  )
}
