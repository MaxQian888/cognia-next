"use client"

/**
 * Add/remove chip list backed by a `string[]` — the gateway's allowlist,
 * exposed models, retry status codes, disable keywords, stripped fields and
 * field-strip re-permits are all this shape.
 *
 * Extracted from `gateway-section.tsx` when that file became a master/detail
 * shell: the six call sites now live in three different panels, so the control
 * had to outlive its former host. Every quirk in the commit path below is
 * load-bearing (see the comments).
 *
 * `validate` exists because three of those lists have a shape Rust enforces
 * later and less helpfully: a bad allowlist CIDR refuses the WHOLE config with
 * an "invalid config" toast, a non-numeric retry status used to be dropped
 * without a word, and a field-strip exception without `provider:` is accepted
 * and then never matches. An invalid draft stays in the input with the reason
 * under it instead of vanishing.
 */

import { useId, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { PlusIcon, XIcon } from "lucide-react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

export interface ChipInputProps {
  values: string[]
  onCommit: (next: string[]) => void
  placeholder: string
  ariaLabel: string
  addLabel: string
  removeLabel: string
  /** Returns a user-facing reason when `value` (already trimmed) is not acceptable. */
  validate?: (value: string) => string | null
}

export function ChipInput({
  values,
  onCommit,
  placeholder,
  ariaLabel,
  addLabel,
  removeLabel,
  validate,
}: ChipInputProps) {
  // Controlled state, not a ref: the earlier ref-backed version silently
  // discarded anything typed but not Enter-ed, which looked exactly like a save
  // that didn't stick.
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const errorId = useId()
  const { reduce, durationScale } = useFlowMotion()

  const commitDraft = () => {
    const value = draft.trim()
    if (!value) {
      setDraft("")
      return
    }
    const reason = validate?.(value) ?? null
    if (reason) {
      // Keep the draft so the typo can be fixed in place.
      setError(reason)
      return
    }
    if (!values.includes(value)) onCommit([...values, value])
    setDraft("")
    setError(null)
  }

  const chipTransition = { duration: 0.14 * durationScale, ease: "easeOut" as const }

  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <AnimatePresence initial={false} mode="popLayout">
            {values.map((entry) => (
              <motion.span
                key={entry}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={
                  reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.94 }
                }
                transition={chipTransition}
                className="inline-flex max-w-full"
              >
                <Badge variant="secondary" className="max-w-full gap-1 py-1 pl-2 pr-1 font-mono">
                  <span className="truncate">{entry}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-5 rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`${removeLabel} ${entry}`}
                    onClick={() => onCommit(values.filter((e) => e !== entry))}
                  >
                    <XIcon className="size-3" aria-hidden />
                  </Button>
                </Badge>
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      )}
      <InputGroup>
        <InputGroupInput
          value={draft}
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          className="font-mono text-xs"
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return
            e.preventDefault()
            commitDraft()
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
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
            <PlusIcon className="size-3.5" aria-hidden />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
