"use client"

/**
 * Settings surface for the tray quick panel.
 *
 * Card-free by construction: it is built from `SettingsStack` / `SettingsBlock`
 * / `SettingsField` (`components/settings/common/settings-block.tsx`), so it
 * reads as one continuous page separated by hairlines rather than a stack of
 * floating boxes, and it sizes off `@container/settings-stack` so it works
 * full-width and inside a narrow detail pane alike.
 *
 * Two things live here: what a tray click does (persisted natively, because
 * the click handler runs with no renderer involved), and the action catalogue
 * (persisted in the shared Tauri store, so the panel window sees edits on its
 * next open).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDownIcon,
  EyeIcon,
  EyeOffIcon,
  ArrowUpIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  TrashIcon,
  MousePointerClickIcon,
  LayoutPanelTopIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { isTauri } from "@/lib/tauri"
import {
  DEFAULT_TRAY_PANEL_CONFIG,
  getTrayPanelConfig,
  openTrayPanel,
  setTrayLeftClickAction,
} from "@/lib/tauri/tray-panel"
import { resolveLabel } from "@/lib/tray-panel/defaults"
import { describeEffect } from "@/lib/tray-panel/resolve"
import { useTrayPanelStore } from "@/lib/tray-panel/store"
import type { TrayLeftClickAction, TrayPanelAction } from "@/lib/tray-panel/types"
import { cn } from "@/lib/utils"

import { TrayPanelActionEditor, blankAction } from "./tray-panel-action-editor"

const LEFT_CLICK_ACTIONS: TrayLeftClickAction[] = ["panel", "toggle-window", "none"]

export function TrayPanelSettings() {
  const t = useTranslations("settings.trayPanel")
  const tRoot = useTranslations()

  const actions = useTrayPanelStore((s) => s.actions)
  const hydrate = useTrayPanelStore((s) => s.hydrate)
  const upsertAction = useTrayPanelStore((s) => s.upsertAction)
  const removeAction = useTrayPanelStore((s) => s.removeAction)
  const moveAction = useTrayPanelStore((s) => s.moveAction)
  const reset = useTrayPanelStore((s) => s.reset)

  const [leftClick, setLeftClick] = useState<TrayLeftClickAction>(
    DEFAULT_TRAY_PANEL_CONFIG.leftClick
  )
  const [editing, setEditing] = useState<TrayPanelAction | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useEffect(() => {
    let cancelled = false
    void getTrayPanelConfig().then((config) => {
      if (!cancelled) setLeftClick(config.leftClick)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const changeLeftClick = useCallback((next: TrayLeftClickAction) => {
    setLeftClick(next)
    void setTrayLeftClickAction(next)
  }, [])

  const toggleHidden = (action: TrayPanelAction) =>
    upsertAction({ ...action, hidden: !action.hidden })

  if (!isTauri()) {
    return <p className="text-sm text-muted-foreground">{t("desktopOnly")}</p>
  }

  return (
    <SettingsStack>
      <SettingsBlock
        icon={<MousePointerClickIcon />}
        title={t("behavior.title")}
        description={t("behavior.description")}
        settingId="tray-panel-behavior"
      >
        <SettingsField
          htmlFor="tray-left-click"
          label={t("behavior.leftClick")}
          description={t("behavior.leftClickHint")}
        >
          <Select
            value={leftClick}
            onValueChange={(v) => changeLeftClick(v as TrayLeftClickAction)}
          >
            <SelectTrigger
              id="tray-left-click"
              className="w-48"
              aria-label={t("behavior.leftClick")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEFT_CLICK_ACTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`behavior.leftClickOptions.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField label={t("behavior.preview")} description={t("behavior.previewHint")}>
          <Button variant="outline" size="sm" onClick={() => void openTrayPanel()}>
            <ExternalLinkIcon className="mr-1.5 size-3.5" />
            {t("behavior.previewAction")}
          </Button>
        </SettingsField>
      </SettingsBlock>

      <SettingsBlock
        icon={<LayoutPanelTopIcon />}
        title={t("actions.title")}
        description={t("actions.description")}
        settingId="tray-panel-actions"
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(blankAction(`trayPanel.custom.${crypto.randomUUID()}`))}
            >
              <PlusIcon className="mr-1.5 size-3.5" />
              {t("actions.add")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => reset()}>
              <RotateCcwIcon className="mr-1.5 size-3.5" />
              {t("actions.reset")}
            </Button>
          </div>
        }
      >
        <ul className="divide-y divide-border/50">
          {actions.map((action, index) => {
            const Icon = resolveIcon(action.icon)
            return (
              <li
                key={action.id}
                data-testid={`tray-panel-row-${action.id}`}
                className={cn(
                  "flex items-center gap-2 py-2 first:pt-0 last:pb-0",
                  action.hidden && "opacity-50"
                )}
              >
                {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {resolveLabel(action, (key) => tRoot(key))}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {t(`editor.triggers.${action.trigger.kind}`)}
                    </Badge>
                    {action.builtIn ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("actions.builtIn")}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {describeEffect(action.effect)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={index === 0}
                    aria-label={t("actions.moveUp")}
                    onClick={() => moveAction(action.id, -1)}
                  >
                    <ArrowUpIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    disabled={index === actions.length - 1}
                    aria-label={t("actions.moveDown")}
                    onClick={() => moveAction(action.id, 1)}
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={action.hidden ? t("actions.show") : t("actions.hide")}
                    onClick={() => toggleHidden(action)}
                  >
                    {action.hidden ? (
                      <EyeOffIcon className="size-3.5" />
                    ) : (
                      <EyeIcon className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    aria-label={t("actions.edit")}
                    onClick={() => setEditing(action)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    // Built-ins are hidden rather than deleted — their ids are
                    // referenced by the shipped defaults, so a delete would be
                    // undone by the next backfill and read as "it came back".
                    disabled={action.builtIn}
                    aria-label={t("actions.remove")}
                    onClick={() => removeAction(action.id)}
                  >
                    <TrashIcon className="size-3.5" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </SettingsBlock>

      {editing ? (
        <TrayPanelActionEditor
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          action={editing}
          onSave={(next) => upsertAction(next)}
        />
      ) : null}
    </SettingsStack>
  )
}
