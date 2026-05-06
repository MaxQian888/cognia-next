"use client"

import React, { memo, useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import {
  Combobox,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { Label } from "@/components/ui/label"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"
import type { A2UIComponentProps, A2UIBaseComponent, A2UIStringOrPath } from "@/types/a2ui/schema"

export interface A2UIComboboxOption {
  value: string
  label: string
  disabled?: boolean
}

export interface A2UIComboboxComponent extends A2UIBaseComponent {
  component: "Combobox"
  options: A2UIComboboxOption[] | A2UIPathValue<A2UIComboboxOption[]>
  value: A2UIStringOrPath
  placeholder?: string
  emptyText?: string
  searchPlaceholder?: string
  label?: string
}

export const A2UICombobox = memo(function A2UICombobox({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIComboboxComponent>) {
  const { resolveString, resolveArray } = useA2UIData()
  const currentValue = resolveString(component.value)
  const options = resolveArray<A2UIComboboxOption>(component.options, [])
  const bindingPath = getBindingPath(component.value)
  const [open, setOpen] = useState(false)

  const selectedLabel = options.find((o) => o.value === currentValue)?.label || ""

  const handleChange = useCallback(
    (newValue: string) => {
      if (bindingPath) {
        onDataChange(bindingPath, newValue)
      }
      setOpen(false)
    },
    [bindingPath, onDataChange]
  )

  return (
    <div
      className={cn("space-y-1.5", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && <Label>{component.label}</Label>}
      <Combobox
        value={currentValue}
        onValueChange={handleChange}
        open={open}
        onOpenChange={setOpen}
      >
        <ComboboxTrigger>{selectedLabel || component.placeholder || "Select..."}</ComboboxTrigger>
        <ComboboxInput placeholder={component.searchPlaceholder || "Search..."} />
        <ComboboxList>
          {options.length === 0 ? (
            <ComboboxEmpty>{component.emptyText || "No results"}</ComboboxEmpty>
          ) : (
            options.map((opt) => (
              <ComboboxItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </ComboboxItem>
            ))
          )}
        </ComboboxList>
      </Combobox>
    </div>
  )
})
