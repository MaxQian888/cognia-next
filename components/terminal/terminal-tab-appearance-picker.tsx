"use client"

/**
 * Color + icon grids for terminal tab customization.
 *
 * Owns no store access and no surface of its own: the parent supplies the
 * current appearance and an `onChange`, and decides where the grids live. That
 * is what lets the tab context menu embed them in a submenu — a `Popover`
 * nested inside a Radix context menu fights it for focus and for the dismiss
 * gesture, and the menu already gives us a positioned, keyboard-navigable
 * surface for free.
 *
 * # The swatches are MENU ITEMS, not buttons in a radiogroup
 *
 * "Keyboard-navigable for free" is only true for things the menu knows about.
 * These grids render inside `ContextMenuSubContent`, which is a `role="menu"`:
 * Radix's roving focus and typeahead walk registered items and nothing else, so
 * plain `<button>`s in a `role="radiogroup"` were unreachable by arrow key,
 * swallowed printable keys into the menu's typeahead, and nested a `radiogroup`
 * inside a `menu` — which is invalid, and announced as an empty submenu.
 *
 * `ContextMenuItem` with `role="menuitemradio"` keeps the compact swatch layout
 * (the default row padding is overridden) while restoring menu semantics.
 * `onSelect` calls `preventDefault()` so picking a colour does not close the
 * menu before the icon can be picked too.
 *
 * It used to wrap itself in its own `Popover` with a colour-dot trigger, and
 * nothing ever rendered it: the store has `setTabAppearance`, the row carries
 * `tabColor`/`tabIcon`, `terminal-tab.tsx` already paints
 * `tabColorBorderClass`, both locales carry the strings, and
 * `TerminalTabContextMenu` has an "Appearance" item — but `terminal-dock.tsx`
 * never passed `onChangeAppearance`, so the item never rendered and this file
 * had no importer at all. Five layers, four of them shipped.
 */

import { useTranslations } from "next-intl"

import { ContextMenuItem } from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import {
  TAB_COLOR_PRESETS,
  TAB_ICON_PRESETS,
  TAB_COLOR_CLASSES,
  type TabColorPreset,
  type TabIconPreset,
} from "@/lib/terminal/tab-appearance"
import { TAB_ICON_COMPONENTS } from "@/lib/terminal/tab-icon-map"

export interface TerminalTabAppearancePickerProps {
  color: TabColorPreset
  icon: TabIconPreset
  onChange: (appearance: { color?: TabColorPreset; icon?: TabIconPreset }) => void
  className?: string
}

export function TerminalTabAppearancePicker({
  color,
  icon,
  onChange,
  className,
}: TerminalTabAppearancePickerProps) {
  const t = useTranslations("terminal.tab.appearance")

  /** Shared swatch chrome — a menu item shrunk to a 24px square. */
  const swatchClass = (selected: boolean) =>
    cn(
      "h-6 w-6 justify-center gap-0 rounded-md border p-0 transition-colors",
      selected ? "border-foreground ring-1 ring-foreground/30" : "border-border"
    )

  return (
    <div className={cn("w-56 p-3", className)} data-testid="tab-appearance-grids">
      {/* Color section. `group`, not `radiogroup`: the parent is a `role="menu"`
          and a radiogroup is not a valid child of one. */}
      <div className="mb-3">
        <p className="mb-1.5 text-xs font-medium text-muted-foreground" id="tab-appearance-color">
          {t("colorLabel")}
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="tab-appearance-color">
          {TAB_COLOR_PRESETS.map((preset) => (
            <ContextMenuItem
              key={preset}
              role="menuitemradio"
              aria-checked={color === preset}
              aria-label={t(`colors.${preset}`)}
              // Radix's typeahead reads this rather than the (icon-only)
              // children, so a keyboard user can jump to "red" by typing it.
              textValue={t(`colors.${preset}`)}
              title={t(`colors.${preset}`)}
              data-testid={`tab-color-${preset}`}
              // Keep the menu open: the icon grid below is the other half of
              // the same decision.
              onSelect={(event) => {
                event.preventDefault()
                onChange({ color: preset })
              }}
              className={swatchClass(color === preset)}
            >
              <span
                className={cn(
                  "inline-block h-3.5 w-3.5 rounded-sm",
                  preset === "none" ? "bg-muted-foreground/30" : TAB_COLOR_CLASSES[preset].dot
                )}
              />
            </ContextMenuItem>
          ))}
        </div>
      </div>
      {/* Icon section */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground" id="tab-appearance-icon">
          {t("iconLabel")}
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="tab-appearance-icon">
          {TAB_ICON_PRESETS.map((preset) => {
            const IconComp = TAB_ICON_COMPONENTS[preset]
            return (
              <ContextMenuItem
                key={preset}
                role="menuitemradio"
                aria-checked={icon === preset}
                aria-label={t(`icons.${preset}`)}
                textValue={t(`icons.${preset}`)}
                title={t(`icons.${preset}`)}
                data-testid={`tab-icon-${preset}`}
                onSelect={(event) => {
                  event.preventDefault()
                  onChange({ icon: preset })
                }}
                className={swatchClass(icon === preset)}
              >
                {IconComp ? (
                  <IconComp className="h-3.5 w-3.5" />
                ) : (
                  <span className="text-[10px] text-muted-foreground">—</span>
                )}
              </ContextMenuItem>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default TerminalTabAppearancePicker
