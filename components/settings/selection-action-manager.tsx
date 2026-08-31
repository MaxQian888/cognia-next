"use client"

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SELECTION_ACTIONS } from "@/components/selection-toolbar/selection-toolbar-actions"
import {
  getQuickActionSnapshot,
  subscribeQuickActions,
} from "@/lib/plugin/registries/quick-action-registry"
import {
  SELECTION_ACTION_LAYOUT_PREF,
  SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF,
} from "@/lib/tauri/selection-toolbar"
import { getPref, setPref } from "@/lib/tauri/store"
import {
  normalizeSelectionActionLayout,
  type SelectionActionLayout,
} from "@/lib/selection/preferences"
import { useShortcutStore } from "@/lib/shortcuts/registry"
import { lookupPluginMessage } from "@/lib/i18n/plugin-i18n-registry"

interface ManagedSelectionAction {
  id: string
  title: string
  replaceDeclared: boolean
  plugin: boolean
}

export function moveSelectionActionId(ids: string[], id: string, delta: -1 | 1): string[] {
  const next = [...ids]
  const index = next.indexOf(id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function mergeRetainedSelectionActionOrder(
  currentOrder: readonly string[],
  visibleOrder: readonly string[]
): string[] {
  const visible = new Set(visibleOrder)
  let visibleIndex = 0
  const merged = currentOrder.map((id) => {
    if (!visible.has(id)) return id
    const replacement = visibleOrder[visibleIndex]
    visibleIndex += 1
    return replacement ?? id
  })
  return [...merged, ...visibleOrder.slice(visibleIndex)]
}

export interface SelectionActionManagerProps {
  /**
   * Whether this build carries selection replacement (`SelectionToolbarStatus.
   * replaceAvailable`). False in every shipped build today, so the per-action
   * Direct Replace switch renders disabled with an explanation instead of
   * accepting a preference that nothing can act on.
   */
  replaceAvailable?: boolean
}

export function SelectionActionManager({ replaceAvailable = false }: SelectionActionManagerProps) {
  const t = useTranslations("settings.desktop.selectionToolbar.actionManager")
  const tToolbar = useTranslations("selectionToolbar")
  const locale = useLocale()
  const pluginEntries = useSyncExternalStore(
    subscribeQuickActions,
    getQuickActionSnapshot,
    getQuickActionSnapshot
  )
  const [layout, setLayout] = useState<SelectionActionLayout>({
    ordered: [],
    hidden: [],
    pinned: [],
  })
  const [directReplace, setDirectReplace] = useState<string[]>([])
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    void Promise.all([
      getPref<SelectionActionLayout>(SELECTION_ACTION_LAYOUT_PREF),
      getPref<string[]>(SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF),
    ]).then(([savedLayout, savedDirectReplace]) => {
      if (!alive) return
      setLayout(normalizeSelectionActionLayout(savedLayout))
      setDirectReplace(Array.isArray(savedDirectReplace) ? savedDirectReplace : [])
    })
    return () => {
      alive = false
    }
  }, [])

  const actions = useMemo<ManagedSelectionAction[]>(() => {
    const builtIns = SELECTION_ACTIONS.map((action) => ({
      id: action.id,
      title: action.labelKey ? tToolbar(action.labelKey) : action.id,
      replaceDeclared: false,
      plugin: false,
    }))
    const rewrite: ManagedSelectionAction = {
      id: "cognia:rewrite",
      title: tToolbar("rewrite.title"),
      replaceDeclared: true,
      plugin: false,
    }
    const plugins = pluginEntries
      .filter((entry) => entry.surfaces.includes("selection") && entry.selection)
      .map((entry) => ({
        id: entry.fullId,
        title: entry.labelKey
          ? (lookupPluginMessage(locale, `plugin.${entry.pluginId}.${entry.labelKey}`) ??
            entry.title)
          : entry.title,
        replaceDeclared: entry.selection?.output === "replace",
        plugin: true,
      }))
    const byId = new Map([...builtIns, rewrite, ...plugins].map((action) => [action.id, action]))
    const ordered = layout.ordered.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    const orderedIds = new Set(ordered.map((action) => action.id))
    return [...ordered, ...[...byId.values()].filter((action) => !orderedIds.has(action.id))]
  }, [layout.ordered, locale, pluginEntries, tToolbar])

  const saveLayout = (next: SelectionActionLayout) => {
    setLayout(next)
    void setPref(SELECTION_ACTION_LAYOUT_PREF, next)
  }

  const toggleList = (key: "hidden" | "pinned", id: string, include: boolean) => {
    if (id === "copy") return
    const values = new Set(layout[key])
    if (include) values.add(id)
    else values.delete(id)
    saveLayout({ ...layout, [key]: [...values] })
  }

  const move = (id: string, delta: -1 | 1) => {
    if (id === "copy") return
    const visibleIds = actions.map((action) => action.id)
    saveLayout({
      ...layout,
      ordered: mergeRetainedSelectionActionOrder(
        layout.ordered,
        moveSelectionActionId(visibleIds, id, delta)
      ),
    })
  }

  const toggleDirectReplace = (id: string, enabled: boolean) => {
    const allowlist = new Set(directReplace)
    if (enabled) allowlist.add(id)
    else allowlist.delete(id)
    const next = [...allowlist]
    setDirectReplace(next)
    void setPref(SELECTION_DIRECT_REPLACE_ALLOWLIST_PREF, next)
  }

  const saveShortcut = (action: ManagedSelectionAction) => {
    const chord = shortcuts[action.id]?.trim()
    if (!chord) return
    void useShortcutStore.getState().bind({
      id: `selection.action:${action.id}`,
      chord,
    })
  }

  return (
    <div className="space-y-3 border-t pt-3">
      <div>
        <Label className="text-xs">{t("title")}</Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-2">
        {actions.map((action, index) => (
          <div
            key={action.id}
            role="group"
            aria-label={action.title}
            className="space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{action.title}</span>
              {action.plugin ? (
                <span className="text-[10px] text-muted-foreground">{t("plugin")}</span>
              ) : null}
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={action.id === "copy" || index === 0}
                aria-label={t("moveUp", { title: action.title })}
                onClick={() => move(action.id, -1)}
              >
                <ArrowUpIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={action.id === "copy" || index === actions.length - 1}
                aria-label={t("moveDown", { title: action.title })}
                onClick={() => move(action.id, 1)}
              >
                <ArrowDownIcon className="size-3.5" />
              </Button>
              <Switch
                checked={action.id === "copy" || !layout.hidden.includes(action.id)}
                disabled={action.id === "copy"}
                onCheckedChange={(enabled) => toggleList("hidden", action.id, !enabled)}
                aria-label={t("enabled", { title: action.title })}
              />
              <Switch
                checked={action.id === "copy" || layout.pinned.includes(action.id)}
                disabled={action.id === "copy"}
                onCheckedChange={(pinned) => toggleList("pinned", action.id, pinned)}
                aria-label={t("pinned", { title: action.title })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={shortcuts[action.id] ?? ""}
                onChange={(event) =>
                  setShortcuts((current) => ({ ...current, [action.id]: event.target.value }))
                }
                placeholder={t("shortcutPlaceholder")}
                aria-label={t("shortcut", { title: action.title })}
                className="h-7 flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => saveShortcut(action)}
                aria-label={t("saveShortcut", { title: action.title })}
              >
                {t("save")}
              </Button>
              {action.replaceDeclared ? (
                <Switch
                  checked={replaceAvailable && directReplace.includes(action.id)}
                  disabled={!replaceAvailable}
                  onCheckedChange={(enabled) => toggleDirectReplace(action.id, enabled)}
                  aria-label={
                    replaceAvailable
                      ? t("directReplace", { title: action.title })
                      : t("directReplaceUnavailable", { title: action.title })
                  }
                  title={replaceAvailable ? undefined : t("directReplaceUnavailableHint")}
                />
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default SelectionActionManager
