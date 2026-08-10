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
  /**
   * Optional gating validator. Returning a non-null string indicates the
   * draft is invalid; the returned value is forwarded to `errorRender`
   * (or shown verbatim) and `onAdd` is suppressed. Returning `null`
   * means valid.
   */
  validate?: (draft: string) => string | null
  /** Optional renderer for the validate-result key (e.g. i18n lookup). */
  errorRender?: (key: string) => ReactNode
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
  validate,
  errorRender,
}: DomainListInputProps) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (validate) {
      const result = validate(trimmed)
      if (result) {
        setError(result)
        return
      }
    }
    setError(null)
    onAdd(trimmed)
    setDraft("")
  }

  const badges = (
    <div className="flex flex-wrap gap-1">
      {domains.map((d) => (
        <Badge key={d} variant="secondary" className="text-xs gap-1 pr-1">
          {badgeIcon}
          {d}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onRemove(d)}
            aria-label={removeAriaLabel?.(d)}
            className="ml-1 size-4 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </Button>
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
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {errorRender ? errorRender(error) : error}
        </p>
      )}
      {domains.length > 0 &&
        (scrollable ? <ScrollArea className="h-24">{badges}</ScrollArea> : badges)}
    </div>
  )
}
