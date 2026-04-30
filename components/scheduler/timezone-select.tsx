"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { TIMEZONE_OPTIONS } from "@/types/scheduler"

interface TimezoneSelectProps {
  value?: string
  onValueChange: (value: string) => void
  testId?: string
  triggerClassName?: string
  contentClassName?: string
  includeOffset?: boolean
  disabled?: boolean
}

export function TimezoneSelect({
  value = "UTC",
  onValueChange,
  testId,
  triggerClassName,
  contentClassName,
  includeOffset = false,
  disabled = false,
}: TimezoneSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className={triggerClassName} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className={cn(contentClassName)}>
        {TIMEZONE_OPTIONS.map((timezone) => (
          <SelectItem key={timezone.value} value={timezone.value}>
            {includeOffset ? `${timezone.label} (${timezone.offset})` : timezone.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export default TimezoneSelect
