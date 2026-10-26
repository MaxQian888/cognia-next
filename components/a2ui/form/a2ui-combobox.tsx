"use client"

import { useTranslations } from "next-intl"
import React, { memo, useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import {
  Combobox,
  ComboboxInput,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
  ComboboxTrigger,
  ComboboxContent,
} from "@/components/ui/combobox"
import { Label } from "@/components/ui/label"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"
import type {
  A2UIComponentProps,
  A2UIBaseComponent,
  A2UIPathValue,
  A2UIStringOrPath,
} from "@/types/a2ui/schema"

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
  const t = useTranslations("a2ui.controls")
  const { resolveString, resolveArray, resolveBoolean } = useA2UIData()
  const currentValue = resolveString(component.value)
  const options = resolveArray<A2UIComboboxOption>(component.options, [])
  const disabled = resolveBoolean(component.disabled ?? false, false)
  const bindingPath = getBindingPath(component.value)
  const [open, setOpen] = useState(false)

  const selectedLabel = options.find((o) => o.value === currentValue)?.label || ""

  const handleChange = useCallback(
    (newValue: string | null) => {
      if (!disabled && bindingPath) {
        onDataChange(bindingPath, newValue ?? "")
      }
      setOpen(false)
    },
    [bindingPath, disabled, onDataChange]
  )

  return (
    <div
      className={cn("space-y-1.5", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && (
        <Label id={`${component.id}-label`} htmlFor={component.id}>
          {component.label}
        </Label>
      )}
      <Combobox
        items={options.map((option) => option.value)}
        itemToStringLabel={(value) =>
          options.find((option) => option.value === value)?.label ?? value
        }
        disabled={disabled}
        value={currentValue || null}
        onValueChange={handleChange}
        open={open}
        onOpenChange={setOpen}
      >
        <ComboboxTrigger
          id={component.id}
          aria-labelledby={component.label ? `${component.id}-label` : undefined}
          aria-label={component.label ? undefined : component.placeholder || t("select")}
        >
          {selectedLabel || component.placeholder || t("select")}
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxInput
            aria-label={component.searchPlaceholder || t("search")}
            placeholder={component.searchPlaceholder || t("search")}
            showTrigger={false}
          />
          <ComboboxEmpty>{component.emptyText || t("noResults")}</ComboboxEmpty>
          <ComboboxList>
            {(value: string) => {
              const option = options.find((item) => item.value === value)
              return (
                <ComboboxItem key={value} value={value} disabled={option?.disabled}>
                  {option?.label ?? value}
                </ComboboxItem>
              )
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
})
