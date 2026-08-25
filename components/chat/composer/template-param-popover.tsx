"use client"

// The editor for one `{{parameter}}` in the composer.
//
// It anchors to the composer container — the same anchor `ComposerPopover`
// uses — rather than to the caret. Caret-relative positioning in a textarea
// means mirroring the whole box to measure a character offset, and it would buy
// nothing here: the panel is small, the parameter it edits is highlighted in
// the text behind it, and every other composer surface already appears in this
// same place.
//
// It never takes focus on open. The user is typing a sentence; a panel that
// yanked the caret out of the textarea because they arrowed through a token
// would be worse than no panel at all. Focus moves here only when they Tab or
// click into it.

import { useTranslations } from "next-intl"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ChatTemplateParamValue } from "@/lib/chat/template/binding"

export interface TemplateParamPopoverProps {
  /** Parameter id being edited, or null when none is. */
  paramId: string | null
  /** Its current value, if any. */
  value: ChatTemplateParamValue | undefined
  /** Element to anchor against — the composer container. */
  anchor: HTMLElement | null
  /** Total parameter count and this one's index, for the "2 of 3" hint. */
  position?: { index: number; total: number }
  onChange(value: ChatTemplateParamValue): void
  onClose(): void
}

export function TemplateParamPopover({
  paramId,
  value,
  anchor,
  position,
  onChange,
  onClose,
}: TemplateParamPopoverProps) {
  const t = useTranslations("chat.composer.templateParams")
  const open = paramId !== null && anchor !== null
  // Fully controlled off the binding — no local draft, so there is no second
  // copy of the value to fall out of step, and no state to re-seed when the
  // edited parameter changes.
  const text = value?.kind === "text" ? value.value : (value?.label ?? "")

  return (
    <Popover open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      {anchor ? <PopoverAnchor virtualRef={{ current: anchor }} /> : null}
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="template-param-popover"
        className="w-[var(--radix-popper-anchor-width)] rounded-xl border-border/70 bg-popover/95 p-3 shadow-xl backdrop-blur-xl"
        // Focus stays in the textarea: the user is mid-sentence, and stealing
        // the caret to a panel they did not ask for is worse than no panel.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <Label className="font-mono text-xs" htmlFor="template-param-input">
              {paramId}
            </Label>
            {position ? (
              <span className="text-xs text-muted-foreground">
                {t("position", { index: position.index + 1, total: position.total })}
              </span>
            ) : null}
          </div>
          <Input
            id="template-param-input"
            value={text}
            placeholder={t("placeholder")}
            onChange={(event) => onChange({ kind: "text", value: event.target.value })}
            onKeyDown={(event) => {
              // Enter confirms — the value is already committed on every
              // keystroke, so this only dismisses. Escape is deliberately NOT
              // handled here: the popover's own dismiss layer listens on the
              // document and already closes it, and claiming the key too would
              // just fire `onClose` twice.
              if (event.key === "Enter") {
                event.preventDefault()
                onClose()
              }
            }}
          />
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
