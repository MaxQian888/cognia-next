"use client"

/**
 * AdapterFormSections — the collapsible-section layout shell used by every
 * platform-specific connector form (lark-config, slack-config, …).
 *
 * Three reasons this exists:
 *   1. Forms grow over time (Identity → + Delivery → + Advanced); a flat
 *      8-section column becomes unreadable.
 *   2. Each section can surface its own validation badge so the user knows
 *      which collapsed section hides the error.
 *   3. Sticky footer (Save / Cancel) stays visible while the user scrolls
 *      the open sections — important for tall forms.
 *
 * NOT to be confused with `components/settings/connections/forms/adapter-form.tsx`
 * which is a JSON-Schema-driven field renderer for plugin-contributed
 * adapters. Different concept; different consumers.
 */

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, AlertTriangleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export interface FormSection {
  /** Stable id; used for keyed rendering and aria-controls. */
  id: string
  /** Localised section heading. */
  label: string
  /** Optional subtitle rendered below the heading when the section is open. */
  description?: string
  /**
   * When set, an "Error" badge appears in the header so the user knows
   * which collapsed section hides the validation issue.
   */
  error?: string
  /** Default open state. Defaults to false. */
  defaultOpen?: boolean
  /** Body content rendered when the section is open. */
  children: ReactNode
}

export interface AdapterFormSectionsProps {
  sections: FormSection[]
  /** Save button handler. Wrapped to await + reset `submitting` automatically. */
  onSubmit: () => void | Promise<void>
  onCancel?: () => void
  /** Override the default Save button label (e.g. "Create"). */
  submitLabel?: string
  /** Disables both buttons; used during in-flight saves. */
  submitting?: boolean
  /** True when at least one section has unsaved edits. */
  dirty?: boolean
  /**
   * Extra footer content rendered between Cancel and Save (e.g. a "Test
   * connection" link). Optional.
   */
  footerSlot?: ReactNode
}

export function AdapterFormSections({
  sections,
  onSubmit,
  onCancel,
  submitLabel,
  submitting = false,
  dirty = false,
  footerSlot,
}: AdapterFormSectionsProps) {
  const t = useTranslations("settings.connections.adapterFormSections")
  const resolvedSubmitLabel = submitLabel ?? t("save")

  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => (
        <SectionBlock key={section.id} section={section} />
      ))}

      <div className="sticky bottom-0 -mx-4 mt-2 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur">
        {footerSlot}
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            {t("cancel")}
          </Button>
        )}
        <Button
          type="button"
          onClick={() => void onSubmit()}
          disabled={submitting || !dirty}
          data-testid="adapter-form-save"
        >
          {submitting ? t("saving") : resolvedSubmitLabel}
        </Button>
      </div>
    </div>
  )
}

function SectionBlock({ section }: { section: FormSection }) {
  const t = useTranslations("settings.connections.adapterFormSections")
  const [open, setOpen] = useState(section.defaultOpen ?? false)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded border bg-card"
      data-testid={`adapter-form-section-${section.id}`}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium",
          "transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
        aria-controls={`adapter-form-section-body-${section.id}`}
      >
        <span className="flex items-center gap-2">
          {section.label}
          {section.error && (
            <Badge
              variant="destructive"
              className="gap-1 text-[10px]"
              data-testid={`adapter-form-section-${section.id}-error-badge`}
              title={section.error}
            >
              <AlertTriangleIcon className="h-3 w-3" />
              {t("errorBadge")}
            </Badge>
          )}
        </span>
        <ChevronDownIcon
          className={cn("h-4 w-4 shrink-0 transition-transform duration-200", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        id={`adapter-form-section-body-${section.id}`}
        className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      >
        <div className="space-y-3 px-4 pb-4">
          {section.description && (
            <p className="text-xs text-muted-foreground">{section.description}</p>
          )}
          {section.children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
