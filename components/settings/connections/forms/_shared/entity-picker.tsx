"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export interface EntityPickerItem {
  id: string
  label: string
  description?: string
  disabled?: boolean
}

export function EntityPicker({
  id,
  value,
  items,
  emptyLabel,
  missingLabel,
  onChange,
  disabled,
  triggerTestId,
}: {
  id: string
  value?: string
  items: readonly EntityPickerItem[]
  emptyLabel: string
  missingLabel: (id: string) => string
  onChange: (id: string | undefined) => void
  disabled?: boolean
  triggerTestId?: string
}) {
  const sentinel = "__inherit__"
  const known = !value || items.some((item) => item.id === value)
  return (
    <Select
      value={value ?? sentinel}
      onValueChange={(next) => onChange(next === sentinel ? undefined : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-testid={triggerTestId ?? id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[50vh]">
        <SelectItem value={sentinel}>{emptyLabel}</SelectItem>
        {!known && value && (
          <SelectItem value={value} className="text-destructive" data-testid={`${id}-missing`}>
            {missingLabel(value)}
          </SelectItem>
        )}
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id} disabled={item.disabled}>
            {item.description ? `${item.label} — ${item.description}` : item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
