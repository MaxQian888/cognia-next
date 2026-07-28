"use client"

import { useTheme } from "next-themes"
import { Icon, type IconName } from "@web/components/icon"
import { ToggleGroup, ToggleGroupItem } from "@web/components/ui/toggle-group"
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
 *
 * Built on Radix's ToggleGroup rather than three buttons in a `role=radiogroup`
 * div, which is what this used to be: that version made every mode its own tab
 * stop and handled no arrow keys, which a radiogroup owes its user. Radix's
 * keyboard model is focus-then-activate — arrows move focus, Space or Enter
 * commits — rather than APG's select-on-arrow. That is the right trade here:
 * selecting on arrow would strobe the entire page through all three themes as
 * a keyboard user walks the group.
 */
export function ThemeToggle({ copy }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme()
  const mounted = useHasMounted()

  // Icons sit beside the words, never replacing them: a three-way control
  // whose options are icon-only is unreadable, and the labels are what name
  // each option for assistive technology.
  const modes: Array<{ value: Mode; label: string; icon: IconName }> = [
    { value: "light", label: copy.themeLight, icon: "themeLight" },
    { value: "dark", label: copy.themeDark, icon: "themeDark" },
    { value: "system", label: copy.themeSystem, icon: "system" },
  ]

  if (!mounted) {
    return <div aria-hidden className="h-8 w-[168px]" />
  }

  const current = theme ?? "system"

  return (
    <ToggleGroup
      type="single"
      value={current}
      // Radix emits "" when the pressed item is pressed again. Ignoring that
      // keeps the control genuinely three-way: there is no "no theme" state to
      // fall into, and a visitor who taps the active mode twice should not end
      // up with the group deselected.
      onValueChange={(next) => {
        if (next) setTheme(next)
      }}
      aria-label={copy.themeToggle}
    >
      {modes.map((mode) => (
        <ToggleGroupItem key={mode.value} value={mode.value} aria-label={mode.label}>
          <Icon name={mode.icon} size={14} />
          {mode.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
