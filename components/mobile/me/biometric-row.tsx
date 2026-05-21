"use client"

import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"

export interface BiometricRowProps {
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
  testid: string
}

export function BiometricRow({ label, help, checked, onChange, testid }: BiometricRowProps) {
  return (
    <Item size="sm" className="px-0">
      <ItemContent>
        <ItemTitle className="text-xs">{label}</ItemTitle>
        <ItemDescription className="text-[11px]">{help}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          data-testid={testid}
          aria-label={label}
        />
      </ItemActions>
    </Item>
  )
}
