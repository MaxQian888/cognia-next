"use client"

import { useTheme } from "next-themes"
import { Icon, type IconName } from "@web/components/icon"
import type { NavCopy } from "@web/content/types"
import { useDismissable } from "@web/hooks/use-dismissable"
import { useHasMounted } from "@web/hooks/use-has-mounted"

type Mode = "light" | "dark" | "system"

interface ThemeToggleProps {
  copy: NavCopy
}

const MODE_ICON: Record<Mode, IconName> = {
  light: "themeLight",
  dark: "themeDark",
  system: "system",
}

/**
 * A single icon button that opens the three modes as a labelled menu.
 *
 * This was a three-way segmented control with all three labels always visible.
 * That kept every mode one click away, but measured 168px, and together with
 * the language switcher the pair ate 291px of a 1480px bar — 20% of the header
 * given to two secondary controls. Collapsed to a trigger, the same control is
 * about 36px.
 *
 * What the segmented version was protecting is kept:
 *
 * - **Still three-way.** A visitor who has never touched this is on `system`,
 *   and a binary toggle would silently spend that choice on the first click.
 * - **Still labelled.** The menu items carry their words; only the *trigger* is
 *   a glyph, and it has an accessible name. An icon-only three-way control
 *   would have been unreadable — an icon-only trigger for a labelled menu is
 *   not the same thing.
 * - **Still keyboard-operable**, via `useDismissable`: Escape closes, an
 *   outside press closes, and focus returns to the trigger. That is the same
 *   hook and the same behaviour as the Product menu next to it, so the header
 *   has one dismissal model rather than two.
 *
 * The control renders only after mount. `next-themes` cannot know the resolved
 * theme during SSR, so rendering the pressed state on the server guarantees a
 * hydration mismatch; a same-sized placeholder keeps the header from shifting.
 */
export function ThemeToggle({ copy }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme()
  const mounted = useHasMounted()
  // Destructured rather than kept as one `menu` object: reading `menu.open` in
  // JSX is a member access on a value that also carries refs, which the
  // compiler's lint rule cannot distinguish from a ref read during render.
  // Separate bindings match the convention in `site-nav.tsx`.
  const {
    open: menuOpen,
    toggle: toggleMenu,
    close: closeMenu,
    containerRef: menuRef,
    triggerRef: menuTriggerRef,
  } = useDismissable<HTMLDivElement>()

  const modes: Array<{ value: Mode; label: string }> = [
    { value: "light", label: copy.themeLight },
    { value: "dark", label: copy.themeDark },
    { value: "system", label: copy.themeSystem },
  ]

  if (!mounted) {
    return <div aria-hidden className="size-8" />
  }

  const current = (theme ?? "system") as Mode

  return (
    <div className="relative">
      <button
        ref={menuTriggerRef}
        type="button"
        onClick={toggleMenu}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        // The glyph shows the mode; the name says what the control is. Without
        // this the button announces as "button" and nothing else.
        aria-label={copy.themeToggle}
        className="inline-flex size-8 items-center justify-center rounded-control border border-hairline text-muted transition-colors hover:text-ink"
      >
        <Icon name={MODE_ICON[current]} size={14} />
      </button>

      {menuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={copy.themeToggle}
          className="absolute right-0 top-full z-50 mt-1 w-40 rounded-panel border border-hairline bg-surface p-1 shadow-sm"
        >
          {modes.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="menuitemradio"
              aria-checked={current === mode.value}
              onClick={() => {
                setTheme(mode.value)
                closeMenu()
              }}
              className={`flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm transition-colors hover:bg-paper ${
                current === mode.value ? "text-ink" : "text-muted"
              }`}
            >
              <Icon name={MODE_ICON[mode.value]} size={14} />
              {mode.label}
              {current === mode.value ? (
                <Icon name="check" size={14} className="ml-auto text-action" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
