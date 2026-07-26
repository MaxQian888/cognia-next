"use client"

import { useTheme } from "next-themes"
import type { NavCopy } from "@web/content/types"
import { useHasMounted } from "@web/hooks/use-has-mounted"

type Mode = "light" | "dark" | "system"

interface ThemeToggleProps {
  copy: NavCopy
}

/**
 * A three-way segmented control rather than a two-state switch: a visitor who
 * has never touched it is on "system", and a binary toggle would silently take
 * that choice away the first time it is used.
 *
 * The control renders only after mount. `next-themes` cannot know the resolved
 * theme during SSR, so rendering the pressed state on the server guarantees a
 * hydration mismatch; a same-sized placeholder keeps the header from shifting.
 */
export function ThemeToggle({ copy }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme()
  const mounted = useHasMounted()

  const modes: Array<{ value: Mode; label: string }> = [
    { value: "light", label: copy.themeLight },
    { value: "dark", label: copy.themeDark },
    { value: "system", label: copy.themeSystem },
  ]

  if (!mounted) {
    return <div aria-hidden className="h-8 w-[168px]" />
  }

  return (
    <div
      role="radiogroup"
      aria-label={copy.themeToggle}
      className="inline-flex h-8 items-center rounded-control border border-hairline p-0.5"
    >
      {modes.map((mode) => {
        const active = (theme ?? "system") === mode.value
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(mode.value)}
            className={`rounded-[6px] px-2.5 py-1 text-xs transition-colors ${
              active ? "bg-ink text-paper" : "text-muted hover:text-ink"
            }`}
          >
            {mode.label}
          </button>
        )
      })}
    </div>
  )
}
