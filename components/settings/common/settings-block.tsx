"use client"

/**
 * Flat settings primitives — the card-free counterpart to `settings-section.tsx`.
 *
 * `SettingsCard` wraps every group in a `<Card>`, which turns a settings page
 * into a stack of floating boxes: nested borders inside a bordered detail pane,
 * a hard cap on how wide a form row can breathe, and no visual relationship
 * between neighbouring groups. These primitives express the same hierarchy with
 * type and hairlines instead of chrome:
 *
 *   SettingsStack   — the page/pane body; separates blocks with one hairline.
 *   SettingsBlock   — a titled group of controls (optionally collapsible).
 *   SettingsField   — one label/description ↔ control row.
 *
 * Everything sizes off `@container/settings-stack`, not the viewport: these
 * render both full-width (a flat page) and inside a ~420px master/detail pane,
 * and `sm:`/`md:` would read the window in the second case and lay two columns
 * into half the room.
 */

import { useState, type ReactNode } from "react"
import { ChevronDownIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/* ── Stack ──────────────────────────────────────────────────────────────── */

export interface SettingsStackProps {
  children: ReactNode
  className?: string
}

/**
 * Vertical container for `SettingsBlock`s. Owns the hairline rhythm so a block
 * never has to know whether it is first or last, and declares the container
 * every field inside it measures against.
 */
export function SettingsStack({ children, className }: SettingsStackProps) {
  return (
    <div
      className={cn(
        "@container/settings-stack flex flex-col divide-y divide-border/60",
        "[&>*]:py-5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0",
        className
      )}
    >
      {children}
    </div>
  )
}

/* ── Block ──────────────────────────────────────────────────────────────── */

interface BlockHeaderProps {
  icon?: ReactNode
  title: string
  description?: string
  badge?: ReactNode
  action?: ReactNode
}

function BlockHeader({ icon, title, description, badge }: BlockHeaderProps) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
      {icon ? (
        <span aria-hidden className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">{title}</span>
          {badge}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs text-pretty text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  )
}

export interface SettingsBlockProps extends BlockHeaderProps {
  children: ReactNode
  className?: string
  contentClassName?: string
  /** Renders the header as a disclosure trigger. */
  collapsible?: boolean
  /** Initial open state for the collapsible variant. Ignored otherwise. */
  defaultOpen?: boolean
  testid?: string
  /**
   * Deep-link anchor (`data-setting-id`). `hooks/settings/use-setting-focus.ts`
   * resolves `?focus=` by querying for it, so a block that replaced a `<Card
   * data-setting-id=…>` must keep carrying the same id or the settings finder's
   * jump silently degrades to a section-level scroll.
   */
  settingId?: string
  /**
   * Extra `data-*` attributes for the root, for a block whose tests or styles
   * key off a reach or state marker (`data-reach`, `data-state`).
   */
  attributes?: Record<`data-${string}`, string | undefined>
}

/**
 * One titled group of settings. No border, no background — the surrounding
 * `SettingsStack` supplies the separation.
 */
export function SettingsBlock({
  icon,
  title,
  description,
  badge,
  action,
  children,
  className,
  contentClassName,
  collapsible = false,
  defaultOpen = true,
  testid,
  settingId,
  attributes,
}: SettingsBlockProps) {
  const [open, setOpen] = useState(defaultOpen)
  const header = <BlockHeader icon={icon} title={title} description={description} badge={badge} />
  const content = <div className={cn("mt-4 space-y-4", contentClassName)}>{children}</div>

  if (!collapsible) {
    return (
      <section
        className={cn("min-w-0", className)}
        data-testid={testid}
        data-setting-id={settingId}
        {...attributes}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          {header}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        {content}
      </section>
    )
  }

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section
        className={cn("min-w-0", className)}
        data-testid={testid}
        data-setting-id={settingId}
        data-open={open}
        {...attributes}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <CollapsibleTrigger
            className={cn(
              "-mx-1 flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-0.5",
              "transition-colors hover:bg-accent/40",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            {header}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </CollapsibleTrigger>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        <CollapsibleContent>{content}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/* ── Field ──────────────────────────────────────────────────────────────── */

export interface SettingsFieldProps {
  /**
   * Id of the control this row labels. Without it the `<Label>` names nothing,
   * so the control has no accessible name — the same trap `SettingsRow`
   * documents.
   */
  htmlFor?: string
  label: string
  description?: string
  children: ReactNode
  className?: string
  /** Puts the control on its own full-width line below the label. */
  stacked?: boolean
  disabled?: boolean
  testid?: string
}

/**
 * A single label ↔ control row: description under the label, control right, a
 * hairline below. Stacks in a narrow container so a long description never
 * squeezes the control to nothing.
 */
export function SettingsField({
  htmlFor,
  label,
  description,
  children,
  className,
  stacked = false,
  disabled = false,
  testid,
}: SettingsFieldProps) {
  return (
    <div
      data-testid={testid}
      className={cn(
        "flex flex-col gap-2 border-b border-border/50 pb-4 last:border-b-0 last:pb-0",
        !stacked && "@md/settings-stack:flex-row @md/settings-stack:items-center",
        !stacked && "@md/settings-stack:justify-between @md/settings-stack:gap-6",
        disabled && "pointer-events-none opacity-50",
        className
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description ? (
          <p className="text-xs text-pretty text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className={cn("min-w-0", stacked ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  )
}
