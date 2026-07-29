"use client"

/**
 * Add/remove chip list backed by a `string[]` — the gateway's allowlist,
 * exposed models, retry status codes, disable keywords, stripped fields and
 * field-strip re-permits are all this shape.
 *
 * Extracted from `gateway-section.tsx` when that file became a master/detail
 * shell: the six call sites now live in three different panels, so the control
 * had to outlive its former host. The behaviour below is deliberately
 * unchanged — every quirk in it is load-bearing (see the comments).
 */

import { useState } from "react"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface ChipInputProps {
  values: string[]
  onCommit: (next: string[]) => void
  placeholder: string
  ariaLabel: string
  addLabel: string
  removeLabel: string
}

export function ChipInput({
  values,
  onCommit,
  placeholder,
  ariaLabel,
  addLabel,
  removeLabel,
}: ChipInputProps) {
  // Controlled state, not a ref: the earlier ref-backed version silently
  // discarded anything typed but not Enter-ed, which looked exactly like a save
  // that didn't stick.
  const [draft, setDraft] = useState("")

  const commitDraft = () => {
    const value = draft.trim()
    if (value && !values.includes(value)) onCommit([...values, value])
    setDraft("")
  }

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((entry) => (
            <span
              key={entry}
              className="flex items-center gap-1 rounded bg-muted py-1 pl-2 pr-1 font-mono text-xs"
            >
              {entry}
              <button
                type="button"
                className="rounded-sm px-1 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`${removeLabel} ${entry}`}
                onClick={() => onCommit(values.filter((e) => e !== entry))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="font-mono text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            e.preventDefault()
            commitDraft()
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!draft.trim()}
          // Qualified by the field: several of these render on one panel and a
          // bare "Add" is ambiguous to a screen reader — and indistinguishable
          // to a test, which then asserts against the wrong (disabled) button
          // and passes for the wrong reason.
          aria-label={`${addLabel} ${ariaLabel}`}
          // Commit on mousedown, NOT click: mousedown blurs the input, whose
          // onBlur commits and clears the draft, which renders this button
          // disabled — so an onClick handler would never fire and the button
          // would be decorative. Ordering mousedown first makes the button the
          // thing that actually commits; the blur that follows sees an empty
          // draft and no-ops.
          onMouseDown={commitDraft}
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
