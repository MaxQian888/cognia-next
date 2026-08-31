"use client"

/**
 * MultiEntityPicker: the list-valued sibling of `EntityPicker`.
 *
 * Several inspector fields are lists of ids (an agent turn's `allowedTools`, a
 * skill node's `skillIds`) and every one of them shipped as a comma-separated
 * `<Input>`. That shape has three failure modes an author cannot see: a stray
 * space becomes part of the id, a typo silently selects nothing, and there is
 * no way to learn what the valid ids even are while the registry holding them
 * sits one import away.
 *
 * Selected values render as removable chips. Adding goes through a
 * Popover + Command list, the same pairing the settings model pickers use.
 * Free entry stays available because none of these registries is a closed set:
 * a plugin tool the host has not loaded yet is still a legal id.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsUpDownIcon, PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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

import type { EntityOption } from "./entity-picker"

export interface MultiEntityPickerProps {
  id: string
  /** Current selection. Callers hold the canonical array. */
  value: readonly string[]
  onChange: (next: string[]) => void
  options: EntityOption[]
  placeholder?: string
  /** Copy shown in place of the chips when nothing is selected. */
  emptyHint?: string
}

export function MultiEntityPicker({
  id,
  value,
  onChange,
  options,
  placeholder,
  emptyHint,
}: MultiEntityPickerProps) {
  const t = useTranslations("workflows.forms.pickers")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const labelFor = useMemo(() => {
    const byValue = new Map(options.map((o) => [o.value, o.label]))
    return (v: string) => byValue.get(v) ?? v
  }, [options])

  const available = useMemo(() => options.filter((o) => !value.includes(o.value)), [options, value])

  const add = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed || value.includes(trimmed)) return
    onChange([...value, trimmed])
    setQuery("")
    setOpen(false)
  }

  const remove = (target: string) => onChange(value.filter((v) => v !== target))

  const canAddLiteral =
    query.trim().length > 0 &&
    !value.includes(query.trim()) &&
    !available.some((o) => o.value === query.trim())

  return (
    <div className="space-y-1.5" data-testid={`${id}-multi`}>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="max-w-full gap-1 pr-1 font-normal"
              data-testid={`${id}-chip-${v}`}
            >
              <span className="truncate">{labelFor(v)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-4 shrink-0 rounded-full p-0 hover:bg-transparent"
                onClick={() => remove(v)}
                aria-label={t("remove", { name: labelFor(v) })}
                data-testid={`${id}-remove-${v}`}
              >
                <XIcon className="size-3" aria-hidden="true" />
              </Button>
            </Badge>
          ))}
        </div>
      ) : emptyHint ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
            data-testid={`${id}-add`}
          >
            <span className="truncate text-muted-foreground">{placeholder}</span>
            <ChevronsUpDownIcon className="ml-2 size-3.5 shrink-0 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter>
            <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder} />
            <CommandList>
              <CommandEmpty>{canAddLiteral ? null : t("noResults")}</CommandEmpty>
              {canAddLiteral ? (
                <CommandGroup>
                  <CommandItem
                    value={query}
                    onSelect={() => add(query)}
                    data-testid={`${id}-add-free`}
                  >
                    <PlusIcon className="mr-2 size-3.5" aria-hidden="true" />
                    {t("addLiteral", { value: query.trim() })}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              <CommandGroup>
                {available.map((o) => (
                  <CommandItem key={o.value} value={o.value} onSelect={() => add(o.value)}>
                    {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
