// Builds the DTO that gets flushed to Rust via `invoke("tray_set_menu", …)`.
//
// Responsibilities:
//   1. Substitute the empty `tray.all-commands` placeholder with the
//      submenu produced by `lib/tray/all-commands.ts`.
//   2. Resolve i18n keys to their localized strings via the `t` function
//      the caller passes in (the renderer pulls it from next-intl).
//   3. Drop items whose `when` expression evaluates to `false` against the
//      provided `TrayStateSnapshot`.
//   4. Strip render-only fields (`when`, `iconHint`, `hidden`) so the DTO
//      matches the Rust shape exactly.

import { buildAllCommandsSubmenu } from "./all-commands"
import { evaluateWhen } from "./when"
import type { TrayActionPayload, TrayMenuItem, TrayStateSnapshot } from "./types"

/** Minimal translator signature — compatible with what `useTranslations()`
 * returns from next-intl. Tests can pass a synthetic identity function. */
export type TrayTranslator = (key: string) => string

interface BuilderInput {
  items: TrayMenuItem[]
  t: TrayTranslator
  snapshot: TrayStateSnapshot
}

/** DTO shape mirrored on the Rust side in `src-tauri/src/tray/dto.rs`. */
export type TrayMenuItemDto =
  | {
      kind: "action"
      id: string
      label: string
      accelerator?: string
      payload: TrayActionPayload
      disabled?: boolean
    }
  | { kind: "separator"; id: string }
  | { kind: "submenu"; id: string; label: string; items: TrayMenuItemDto[] }

export function buildTrayPayload({ items, t, snapshot }: BuilderInput): TrayMenuItemDto[] {
  const out: TrayMenuItemDto[] = []
  for (const item of items) {
    const built = transform(item, t, snapshot)
    if (built) out.push(built)
  }
  return collapseAdjacentSeparators(out)
}

function transform(
  item: TrayMenuItem,
  t: TrayTranslator,
  snapshot: TrayStateSnapshot
): TrayMenuItemDto | null {
  // `hidden` is the user's soft-hide toggle from the settings UI; `when` is
  // the state-driven predicate. Either suppresses the item.
  if (isHidden(item)) return null
  if (whenOf(item) && !evaluateWhen(whenOf(item), snapshot)) return null

  switch (item.kind) {
    case "separator":
      return { kind: "separator", id: item.id }
    case "submenu": {
      // Swap the All-Commands placeholder's empty `items` for the live
      // submenu generated from the slash + plugin registries. We walk the
      // generated *children* with `transform` rather than re-entering the
      // top-level transform on the synthetic submenu — re-entering would
      // see the same `tray.all-commands` id and recurse infinitely.
      let workingItems = item.items
      if (item.id === "tray.all-commands" && item.items.length === 0) {
        workingItems = buildAllCommandsSubmenu().items
      }
      const children: TrayMenuItemDto[] = []
      for (const child of workingItems) {
        const built = transform(child, t, snapshot)
        if (built) children.push(built)
      }
      if (children.length === 0) return null
      return {
        kind: "submenu",
        id: item.id,
        label: t(item.label),
        items: collapseAdjacentSeparators(children),
      }
    }
    case "action":
      return {
        kind: "action",
        id: item.id,
        label: t(item.label),
        accelerator: item.accelerator,
        payload: item.payload,
        disabled: item.disabled,
      }
  }
}

function whenOf(item: TrayMenuItem): string | undefined {
  return "when" in item ? item.when : undefined
}

function isHidden(item: TrayMenuItem): boolean {
  return "hidden" in item ? Boolean(item.hidden) : false
}

/**
 * Collapse runs of separators that result from hidden items so the OS menu
 * doesn't end up with `--- --- ---` blocks. Also strips a leading /
 * trailing separator since the OS renders both as visual cruft.
 */
function collapseAdjacentSeparators(items: TrayMenuItemDto[]): TrayMenuItemDto[] {
  const out: TrayMenuItemDto[] = []
  let lastWasSeparator = true // treat "before the first item" as separator
  for (const item of items) {
    if (item.kind === "separator") {
      if (lastWasSeparator) continue
      out.push(item)
      lastWasSeparator = true
    } else {
      out.push(item)
      lastWasSeparator = false
    }
  }
  // Strip trailing separator.
  while (out.length > 0 && out[out.length - 1].kind === "separator") {
    out.pop()
  }
  return out
}
