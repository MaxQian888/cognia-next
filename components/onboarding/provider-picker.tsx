"use client"

import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { cn } from "@/lib/utils"
import {
  groupOnboardingProviders,
  onboardingProviderOption,
} from "@/lib/onboarding/provider-catalog"

interface ProviderPickerProps {
  value: string
  onChange: (providerId: string) => void
  disabled?: boolean
  /** Ties the trigger to the form's own label. */
  id?: string
}

/**
 * Which provider the first-run key form is configuring.
 *
 * **A combobox, not a select.** The catalog is 77 entries deep; a plain
 * `<select>` of that length is a scroll hunt, and the whole point of offering
 * the catalog rather than a shortlist is that a user can find the one they
 * already pay for. Search is what makes the length survivable.
 *
 * Grouped by category with flagships first and local second — see
 * `lib/onboarding/provider-catalog.ts` for why that order.
 */
export function ProviderPicker({ value, onChange, disabled = false, id }: ProviderPickerProps) {
  const t = useTranslations("onboarding")
  const [open, setOpen] = useState(false)
  // The catalog is a module constant; grouping it on every keystroke of the
  // search box would re-sort 77 rows for nothing.
  const groups = useMemo(() => groupOnboardingProviders(), [])
  const selected = onboardingProviderOption(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid="onboarding-provider-picker"
          className="h-10 w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ProviderIcon providerId={value} size={16} className="shrink-0" />
            <span className="truncate">{selected?.name ?? value}</span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        data-testid="onboarding-provider-picker-content"
      >
        <Command>
          <CommandInput placeholder={t("provider.pickerSearch")} />
          <CommandList>
            <CommandEmpty>{t("provider.pickerEmpty")}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.category} heading={t(`provider.category.${group.category}`)}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.id}
                    // Searched by name *and* id: people type "gpt" for OpenAI
                    // and "ollama" for the local server, and only one of those
                    // is in the display name.
                    value={`${option.name} ${option.id}`}
                    onSelect={() => {
                      onChange(option.id)
                      setOpen(false)
                    }}
                    data-testid={`onboarding-provider-option-${option.id}`}
                  >
                    <ProviderIcon providerId={option.id} size={16} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    <CheckIcon
                      className={cn("size-4", option.id === value ? "opacity-100" : "opacity-0")}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
