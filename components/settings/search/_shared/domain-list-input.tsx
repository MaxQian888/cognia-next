"use client"

import { useState, type ReactNode } from "react"
import { Plus, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"

export interface DomainListInputProps {
  label: ReactNode
  placeholder: string
  domains: string[]
  onAdd: (raw: string) => void
  onRemove: (domain: string) => void
  badgeIcon?: ReactNode
  showAddButton?: boolean
  scrollable?: boolean
  removeAriaLabel?: (domain: string) => string
}

export function DomainListInput({
  label,
  placeholder,
  domains,
  onAdd,
  onRemove,
  badgeIcon,
  showAddButton = false,
  scrollable = false,
  removeAriaLabel,
}: DomainListInputProps) {
  const [draft, setDraft] = useState("")

  const submit = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setDraft("")
  }

  const badges = (
    <div className="flex flex-wrap gap-1">
      {domains.map((d) => (
        <Badge key={d} variant="secondary" className="text-xs gap-1 pr-1">
          {badgeIcon}
          {d}
          <button
            type="button"
            onClick={() => onRemove(d)}
            aria-label={removeAriaLabel?.(d)}
            className="ml-1 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  )

  return (
    <div className="space-y-1.5">
      {typeof label === "string" ? <Label className="text-sm">{label}</Label> : label}
      <div className="flex gap-2">
        <Input
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
          className="h-8 text-sm"
        />
        {showAddButton && (
          <Button size="sm" variant="outline" onClick={submit} disabled={!draft.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>
      {domains.length > 0 &&
        (scrollable ? <ScrollArea className="h-24">{badges}</ScrollArea> : badges)}
    </div>
  )
}
