"use client"

/**
 * The container every searchable picker in the app wears, and nothing else.
 *
 * There were four near-identical `Popover` + `Command` model pickers, a
 * `DropdownMenu` runtime selector, a hand-rolled squad radio list, and a
 * `Popover` effort selector. All of them answered "which one of these" and none
 * of them agreed on the frame around the answer: three different overlay
 * primitives, three different shadows, and on a phone every one of them stayed
 * an anchored desktop popover with 32px rows.
 *
 * This owns the FRAME ONLY. The list stays cmdk (`components/ui/command.tsx`,
 * 25 consumers and the app's picker vocabulary), so an existing picker migrates
 * by swapping its `<Popover>...</PopoverContent>` for `<ResponsivePicker>` and
 * changing nothing else. That is deliberate: `components/ui/combobox.tsx` is
 * base-ui and nicer for single-value autocomplete, but every picker here groups
 * by provider or lane with separators and multi-column rows, and moving 25
 * callers to a different list engine to gain a touch-density variant we can
 * write in one line is a trade nobody asked for.
 *
 * Two shells, one content:
 *
 *  - At 768px and up, an anchored `Popover` over `<Surface layer="overlay">`.
 *    Not `bg-popover` plus a hardcoded `shadow-xl`, which is what every picker
 *    did and is why the style packs' elevation ceiling (`data-elevation-max`,
 *    ADR-0148) could never reach a single one of them.
 *  - Below 768px, a full-width bottom `Drawer`. This is what Cursor, Warp and
 *    Linear all do on a phone, and the reason is mechanical rather than
 *    fashionable: an anchored popover next to a composer chip at the bottom of
 *    a 375px screen opens into the keyboard.
 *
 * Two shapes of content, one frame. `variant="list"` (the default) wraps the
 * children in cmdk. `variant="panel"` does not, for a picker whose body is a
 * form rather than a list: the thinking-level card and the composition axes are
 * both sliders and selects, and forcing them through a `Command` would hand
 * cmdk their keystrokes. A panel still gets the same tier, the same drawer on a
 * phone, and the same clamp.
 *
 * Height is clamped explicitly in the drawer. `CommandList` ships
 * `max-h-[300px]`, which is right under a popover and wrong in a sheet, and a
 * `max-height` beats `flex-1`, so without the override a long model list either
 * stayed a 300px stub or, once overridden naively, grew until it pushed its own
 * trigger off-screen.
 *
 * KNOWN TRAP, encoded here so no caller has to rediscover it: a Drawer unmounts
 * its children when it closes. Anything a row action opens (a "Manage..."
 * dialog, a confirm) must be mounted OUTSIDE this component, as a sibling. The
 * pattern to copy is `useWorkspacePickerDialogs` in
 * `components/workspace/workspace-picker-list.tsx`, which returns the dialogs
 * as an element for the caller to place.
 */

import { type ComponentProps, type ReactNode } from "react"

import { Command } from "@/components/ui/command"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Surface } from "@/components/surface/surface"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { cn } from "@/lib/utils"

/**
 * Touch treatment for the drawer branch.
 *
 * The rows arrive from callers as `CommandItem`s tuned for a popover, so the
 * density is applied from the container by `data-slot` rather than by asking
 * every caller to thread a prop. 44px is the floor every mobile HIG agrees on,
 * and the list clamp keeps the sheet from growing past its own trigger.
 */
const DRAWER_DENSITY = [
  "[&_[data-slot=command-item]]:min-h-11",
  "[&_[data-slot=command-item]]:px-3",
  "[&_[data-slot=command-item]]:text-sm",
  "[&_[data-slot=command-input]]:h-12",
  "[&_[data-slot=command-input-wrapper]]:h-12",
  "[&_[data-slot=command-input-wrapper]]:px-4",
  "[&_[data-slot=command-list]]:max-h-[min(60vh,calc(100dvh-13rem))]",
].join(" ")

export interface ResponsivePickerProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** The chip or button that opens it. Rendered `asChild` in both shells. */
  trigger: ReactNode
  /**
   * Names the surface. Visible as the drawer's heading. The popover carries it
   * as `aria-label`, because a popover with a rendered title would grow a
   * header row the desktop layout has never had.
   */
  title: string
  /** Sub-line under the drawer heading. Screen-reader only on the popover. */
  description?: string
  children: ReactNode
  /**
   * `list` wraps the children in cmdk `<Command>`, which is what a searchable
   * option list wants. `panel` renders them bare, for a body that is a form.
   */
  variant?: "list" | "panel"
  /** Popover-only geometry. Ignored in the drawer, which is always full width. */
  align?: ComponentProps<typeof PopoverContent>["align"]
  side?: ComponentProps<typeof PopoverContent>["side"]
  sideOffset?: number
  /** Width and shape of the popover panel. The drawer is full-bleed by definition. */
  contentClassName?: string
  /** Reaches the inner `<Command>` in both shells, for cmdk slot overrides. */
  commandClassName?: string
  /** Test id on whichever panel is rendered. */
  testId?: string
}

export function ResponsivePicker({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  variant = "list",
  align = "center",
  side = "top",
  sideOffset = 8,
  contentClassName,
  commandClassName,
  testId,
}: ResponsivePickerProps) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent
          data-testid={testId ?? "responsive-picker-drawer"}
          // Bounded from the top so the sheet cannot swallow the screen, and
          // padded at the bottom for the home indicator. The list inside does
          // the scrolling. This element never does.
          className="max-h-[min(85vh,calc(100dvh-4rem))] pb-[env(safe-area-inset-bottom)]"
        >
          <DrawerHeader className="pb-2 text-left">
            <DrawerTitle className="text-sm">{title}</DrawerTitle>
            {description ? (
              <DrawerDescription className="text-xs">{description}</DrawerDescription>
            ) : (
              // vaul warns without a description, and an empty one is a lie to
              // a screen reader, so reuse the title rather than invent copy.
              <DrawerDescription className="sr-only">{title}</DrawerDescription>
            )}
          </DrawerHeader>
          {variant === "list" ? (
            <Command
              className={cn(
                "min-h-0 flex-1 bg-transparent",
                "**:data-[slot=command-input-wrapper]:h-auto",
                DRAWER_DENSITY,
                commandClassName
              )}
            >
              {children}
            </Command>
          ) : (
            // A form body scrolls itself. cmdk owns the scrolling in the list
            // branch via `CommandList`, and there is no equivalent here.
            <div
              className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", commandClassName)}
              data-testid="responsive-picker-panel"
            >
              {children}
            </div>
          )}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {/*
        `asChild` so the tier lands ON the popover panel. `Surface` sets
        `bg-[var(--surface-bg)]`, and Tailwind sorts arbitrary values after
        named ones, so it wins over `PopoverContent`'s own `bg-popover` without
        either of them leaving `@layer`.
      */}
      <Surface asChild layer="overlay" radius="panel" elevation={2}>
        <PopoverContent
          align={align}
          side={side}
          sideOffset={sideOffset}
          aria-label={title}
          data-testid={testId ?? "responsive-picker-popover"}
          className={cn(
            "w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden p-0",
            // The pack owns the depth now. `shadow-none` clears the primitive's
            // built-in `shadow-md` so `data-elevation` is the only thing
            // drawing one, which is what makes the `sharp` pack flat here.
            "shadow-none",
            contentClassName
          )}
        >
          {description ? <span className="sr-only">{description}</span> : null}
          {variant === "list" ? (
            <Command
              className={cn(
                "bg-transparent",
                "**:data-[slot=command-input-wrapper]:h-auto",
                commandClassName
              )}
            >
              {children}
            </Command>
          ) : (
            <div className={commandClassName} data-testid="responsive-picker-panel">
              {children}
            </div>
          )}
        </PopoverContent>
      </Surface>
    </Popover>
  )
}

export interface PickerRowProps {
  /** Leading glyph, brand mark or avatar. */
  media?: ReactNode
  title: ReactNode
  /** Second line: the raw id, a path, a member count. */
  description?: ReactNode
  /** Right-aligned cluster read as one unit: badges, counts, capability icons. */
  meta?: ReactNode
  /** Warning or blocked explanation, under both lines. */
  note?: ReactNode
  active?: boolean
  className?: string
}

/**
 * The row shape every picker shares.
 *
 * Lifted verbatim from the model picker's already-tuned two-column read rather
 * than redesigned: identity on the left, everything that DESCRIBES the option
 * right-aligned against the opposite edge. The tick used to lead every row
 * through a 32px gutter that 99% of rows spent empty.
 *
 * The tick's box is reserved with `opacity` rather than conditionally mounted,
 * because the meta column steps sideways on the one row that owns it otherwise.
 *
 * Rendered as the CHILD of a `CommandItem`, so cmdk keeps ownership of `value`,
 * filtering, keyboard selection and `data-selected`.
 */
export function PickerRow({
  media,
  title,
  description,
  meta,
  note,
  active = false,
  className,
}: PickerRowProps) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", className)}>
      {media ? <span className="flex shrink-0 items-center">{media}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "min-w-0 truncate text-xs leading-none",
            active && "font-medium text-foreground"
          )}
        >
          {title}
        </span>
        {description ? (
          <span className="truncate text-[10px] leading-tight text-muted-foreground">
            {description}
          </span>
        ) : null}
        {note ? (
          <span className="line-clamp-2 text-[10px] leading-tight text-amber-600 dark:text-amber-400">
            {note}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          {meta}
        </span>
      ) : null}
      <PickerCheck active={active} />
    </span>
  )
}

/** The reserved tick. Exported for rows that lay out their own columns. */
export function PickerCheck({ active }: { active: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0 text-primary", active ? "opacity-100" : "opacity-0")}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
