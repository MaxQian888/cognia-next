"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { GitRef } from "@/types/git"

interface GitRefSelectProps {
  refs: GitRef[]
  value: string | null
  onValueChange: (value: string) => void
  placeholder: string
  ariaLabel: string
  testId: string
  className?: string
}

/** Read-only repository-ref picker. Selecting a value never mutates Git state. */
export function GitRefSelect({
  refs,
  value,
  onValueChange,
  placeholder,
  ariaLabel,
  testId,
  className,
}: GitRefSelectProps) {
  return (
    <Select value={value ?? undefined} onValueChange={onValueChange}>
      <SelectTrigger className={className} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {refs.map((ref) => (
          <SelectItem key={ref.name} value={ref.name} data-testid={`${testId}-${ref.name}`}>
            {ref.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
