"use client"

/**
 * Pick one issue from the workspace: the parent picker and the "add blocker"
 * control share it. A Popover over a Command list, searched by identifier and
 * title, with the entries the write would refuse rendered disabled rather
 * than hidden (the same rule `menu-model` follows for property menus).
 */

import { CheckIcon, PlusIcon } from "lucide-react"
import { useState, type ReactNode } from "react"
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
import { IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { cn } from "@/lib/utils"
import type { UnifiedIssueItem } from "@/types/issues/unified"

export interface IssuePickerCandidate {
  /** Local issue id (`sourceId`), which is what relations store. */
  id: string
  identifier: string
  title: string
  status: UnifiedIssueItem["status"]
  /** Selecting this would be refused (a loop, the issue itself, already listed). */
  disabled?: boolean
}

export interface IssuePickerProps {
  candidates: readonly IssuePickerCandidate[]
  /** The currently chosen id, when the picker stands for a single value. */
  value?: string
  onPick: (id: string) => void
  /** The trigger's text. Defaults to a "+" button. */
  children?: ReactNode
  triggerLabel: string
  disabled?: boolean
  testId: string
}

export function IssuePicker({
  candidates,
  value,
  onPick,
  children,
  triggerLabel,
  disabled,
  testId,
}: IssuePickerProps) {
  const t = useTranslations("issues.planning")
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children ?? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={triggerLabel}
            title={triggerLabel}
            disabled={disabled}
            data-testid={`${testId}-trigger`}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={t("searchPlaceholder")} data-testid={`${testId}-search`} />
          <CommandList>
            <CommandEmpty>{t("noMatch")}</CommandEmpty>
            <CommandGroup>
              {candidates.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={`${candidate.identifier} ${candidate.title}`}
                  disabled={candidate.disabled}
                  onSelect={() => {
                    onPick(candidate.id)
                    setOpen(false)
                  }}
                  data-testid={`${testId}-option-${candidate.id}`}
                >
                  <IssueStatusIcon status={candidate.status} />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {candidate.identifier}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate")}>{candidate.title}</span>
                  {value === candidate.id ? <CheckIcon className="size-3.5" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
