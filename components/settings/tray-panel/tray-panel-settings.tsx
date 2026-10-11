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
 * What lives here: what a tray click does (persisted natively, because the
 * click handler runs with no renderer involved); the panel's modules with a
 * live preview, and its size and defaults (ADR-0225 §12); and the action
 * catalogue. Modules, layout and actions are all in `AppSettings`, and the
 * panel window receives them in the glance snapshot, so an edit here repaints
 * an open panel at once.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
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
  LayoutListIcon,
  PanelsTopLeftIcon,
} from "lucide-react"

import { GlanceLayoutEditor } from "@/components/glance/glance-layout-editor"
import { GlancePresetMenu } from "@/components/glance/glance-preset-menu"
import { useTrayPanelActions } from "@/hooks/tray-panel/use-tray-panel-actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
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
import { withEditedEntries, withPreset } from "@/lib/glance/layout-edit"
import { clampMaxHeight, normalizeGlancePanelSettings } from "@/lib/glance/presets"
import { glanceModulesFor } from "@/lib/glance/registry"
import { isTauri } from "@/lib/tauri"
import {
  DEFAULT_TRAY_PANEL_CONFIG,
  getTrayPanelConfig,
  openTrayPanel,
  setTrayLeftClickAction,
} from "@/lib/tauri/tray-panel"
import { resolveLabel } from "@/lib/tray-panel/defaults"
import { describeEffect } from "@/lib/tray-panel/resolve"
import type { TrayLeftClickAction, TrayPanelAction } from "@/lib/tray-panel/types"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import {
  GLANCE_MAX_HEIGHT_MAX,
  GLANCE_MAX_HEIGHT_MIN,
  GLANCE_WIDTH_PX,
  GLANCE_WIDTH_STEPS,
  type GlancePanelSettings,
  type GlanceScope,
  type GlanceWidthStep,
} from "@/types/glance/layout"

import { TrayPanelActionEditor, blankAction } from "./tray-panel-action-editor"
import { TrayPanelPreview } from "./tray-panel-preview"

const LEFT_CLICK_ACTIONS: TrayLeftClickAction[] = ["panel", "toggle-window", "none"]
const DESKTOP_MODULES = glanceModulesFor("desktop")
const SCOPES: GlanceScope[] = ["all", "workspace"]

export function TrayPanelSettings() {
  const t = useTranslations("settings.trayPanel")
  const tRoot = useTranslations()

  const {
    actions,
    upsert: upsertAction,
    remove: removeAction,
    move: moveAction,
    reset,
  } = useTrayPanelActions()

  const [leftClick, setLeftClick] = useState<TrayLeftClickAction>(
    DEFAULT_TRAY_PANEL_CONFIG.leftClick
  )
  const [editing, setEditing] = useState<TrayPanelAction | null>(null)

  // The panel's own layout (ADR-0225) lives in AppSettings; the panel window
  // receives it through the glance snapshot, so a change here repaints an open
  // panel immediately.
  const storedLayout = useSettingsStore((s) => s.settings?.trayPanelLayout)
  const saveSettings = useSettingsStore((s) => s.save)
  const layout = useMemo(() => normalizeGlancePanelSettings(storedLayout), [storedLayout])
  const saveLayout = useCallback(
    (next: GlancePanelSettings) => void saveSettings({ trayPanelLayout: next }),
    [saveSettings]
  )
  const patchLayout = useCallback(
    (patch: Partial<GlancePanelSettings>) => saveLayout({ ...layout, ...patch }),
    [layout, saveLayout]
  )
  // The slider moves locally and commits on release, so a drag is one write.
  const [draftHeight, setDraftHeight] = useState<number | null>(null)

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
        icon={<LayoutListIcon />}
        title={t("modules.title")}
        description={t("modules.description")}
        settingId="tray-panel-modules"
        action={
          <GlancePresetMenu
            preset={layout.preset}
            onApply={(preset) => saveLayout(withPreset(layout, preset))}
            align="end"
            className="h-8 border px-2.5 text-sm"
          />
        }
      >
        <div className="grid gap-6 @md/settings-stack:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0 space-y-4">
            <GlanceLayoutEditor
              entries={layout.entries}
              onChange={(entries) => saveLayout(withEditedEntries(layout, entries))}
              available={DESKTOP_MODULES}
            />
            <SettingsField
              htmlFor="tray-panel-delegate"
              label={t("modules.delegate")}
              description={t("modules.delegateHint")}
            >
              <Switch
                id="tray-panel-delegate"
                checked={layout.showDelegate}
                onCheckedChange={(checked) => patchLayout({ showDelegate: checked })}
              />
            </SettingsField>
          </div>
          <TrayPanelPreview />
        </div>
      </SettingsBlock>

      <SettingsBlock
        icon={<PanelsTopLeftIcon />}
        title={t("layout.title")}
        description={t("layout.description")}
        settingId="tray-panel-layout"
      >
        <SettingsField
          htmlFor="tray-panel-width"
          label={t("layout.width")}
          description={t("layout.widthHint")}
        >
          <Select
            value={layout.width}
            onValueChange={(v) => patchLayout({ width: v as GlanceWidthStep })}
          >
            <SelectTrigger id="tray-panel-width" className="w-48" aria-label={t("layout.width")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GLANCE_WIDTH_STEPS.map((step) => (
                <SelectItem key={step} value={step}>
                  {t(`layout.widthOptions.${step}`, { px: GLANCE_WIDTH_PX[step] })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField
          htmlFor="tray-panel-max-height"
          label={t("layout.maxHeight")}
          description={t("layout.maxHeightHint")}
        >
          <div className="flex w-64 items-center gap-3">
            <Slider
              id="tray-panel-max-height"
              aria-label={t("layout.maxHeight")}
              min={GLANCE_MAX_HEIGHT_MIN}
              max={GLANCE_MAX_HEIGHT_MAX}
              step={10}
              value={[draftHeight ?? layout.maxHeight]}
              onValueChange={([v]) => setDraftHeight(v)}
              onValueCommit={([v]) => {
                setDraftHeight(null)
                patchLayout({ maxHeight: clampMaxHeight(v) })
              }}
            />
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {t("layout.px", { px: draftHeight ?? layout.maxHeight })}
            </span>
          </div>
        </SettingsField>

        <SettingsField
          htmlFor="tray-panel-scope"
          label={t("layout.scope")}
          description={t("layout.scopeHint")}
        >
          <Select
            value={layout.scope}
            onValueChange={(v) => patchLayout({ scope: v as GlanceScope })}
          >
            <SelectTrigger id="tray-panel-scope" className="w-48" aria-label={t("layout.scope")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {t(`layout.scopeOptions.${scope}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField
          htmlFor="tray-panel-autofocus"
          label={t("layout.autofocus")}
          description={t("layout.autofocusHint")}
        >
          <Switch
            id="tray-panel-autofocus"
            checked={layout.autofocusDelegate}
            disabled={!layout.showDelegate}
            onCheckedChange={(checked) => patchLayout({ autofocusDelegate: checked })}
          />
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
