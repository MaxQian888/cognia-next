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
//
// Which editor appears is the parameter's DECLARATION talking, not a guess from
// the value: free text, a closed list, or one of the composer's own `@` pickers
// (see `use-template-resource-search.ts`). An undeclared token — someone typed
// `{{module}}` into an empty box — is free text, which is the only thing it
// could be.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check } from "lucide-react"

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { ChatTemplateParamValue } from "@/lib/chat/template/binding"
import type { ChatTemplateParam } from "@/lib/chat/template/template"
import {
  isResourceParamKind,
  resourceParamValue,
  type ResourceOption,
} from "@/lib/chat/template/resource-kinds"
import type { TemplateResourceSearch } from "@/hooks/chat/use-template-resource-search"

export interface TemplateParamPopoverProps {
  /** Parameter id being edited, or null when none is. */
  paramId: string | null
  /** Its declaration, when the draft came from a saved template. */
  param?: ChatTemplateParam | null
  /** Its current value, if any. */
  value: ChatTemplateParamValue | undefined
  /** Element to anchor against — the composer container. */
  anchor: HTMLElement | null
  /** Total parameter count and this one's index, for the "2 of 3" hint. */
  position?: { index: number; total: number }
  /** Candidate lookup for resource parameters. Omit and they fall back to text. */
  searchResources?: TemplateResourceSearch
  onChange(value: ChatTemplateParamValue): void
  onClose(): void
}

export function TemplateParamPopover({
  paramId,
  param,
  value,
  anchor,
  position,
  searchResources,
  onChange,
  onClose,
}: TemplateParamPopoverProps) {
  const t = useTranslations("chat.composer.templateParams")
  const open = paramId !== null && anchor !== null
  // Fully controlled off the binding — no local draft, so there is no second
  // copy of the value to fall out of step, and no state to re-seed when the
  // edited parameter changes.
  const text = value?.kind === "text" ? value.value : (value?.label ?? "")

  const resourceKind =
    param?.kind === "resource" && isResourceParamKind(param.resourceKind) && searchResources
      ? param.resourceKind
      : null
  const options = param?.kind === "enum" ? (param.options ?? []) : []

  const confirmOnEnter = useCallback(
    (event: React.KeyboardEvent) => {
      // Enter confirms — the value is already committed on every keystroke, so
      // this only dismisses. Escape is deliberately NOT handled here: the
      // popover's own dismiss layer listens on the document and already closes
      // it, and claiming the key too would just fire `onClose` twice.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

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
              {param?.label || paramId}
            </Label>
            {position ? (
              <span className="text-xs text-muted-foreground">
                {t("position", { index: position.index + 1, total: position.total })}
              </span>
            ) : null}
          </div>
          {param?.description ? (
            <p className="text-xs text-muted-foreground">{param.description}</p>
          ) : null}
          {resourceKind ? (
            <ResourcePicker
              resourceKind={resourceKind}
              search={searchResources!}
              selectedId={value?.kind === "resource" ? value.id : null}
              // Remounting per parameter throws away the previous one's query
              // and results, so Tabbing between two file parameters can't show
              // the second one the first one's list for a frame.
              key={paramId ?? ""}
              onPick={(option) => {
                onChange(resourceParamValue(resourceKind, option))
                onClose()
              }}
            />
          ) : options.length > 0 ? (
            <div className="flex flex-col gap-1" role="listbox">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={text === option}
                  className={cn(
                    "flex items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    text === option && "bg-accent/60"
                  )}
                  onClick={() => {
                    onChange({ kind: "text", value: option })
                    onClose()
                  }}
                >
                  <span className="truncate">{option}</span>
                  {text === option ? <Check className="size-3.5 shrink-0" /> : null}
                </button>
              ))}
            </div>
          ) : param?.multiline ? (
            <Textarea
              id="template-param-input"
              value={text}
              rows={3}
              placeholder={t("placeholder")}
              className="resize-none text-sm"
              onChange={(event) => onChange({ kind: "text", value: event.target.value })}
              // Shift+Enter stays a newline in a multi-line field; plain Enter
              // still confirms, matching the single-line case.
              onKeyDown={confirmOnEnter}
            />
          ) : (
            <Input
              id="template-param-input"
              value={text}
              placeholder={t("placeholder")}
              onChange={(event) => onChange({ kind: "text", value: event.target.value })}
              onKeyDown={confirmOnEnter}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {resourceKind || options.length > 0 ? t("pickHint") : t("hint")}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface ResourcePickerProps {
  resourceKind: string
  search: TemplateResourceSearch
  selectedId: string | null
  onPick(option: ResourceOption): void
}

/**
 * A query box over one of the composer's `@` sources.
 *
 * Debounced at the same 200ms the `@file` menu uses — the file kind is an IPC
 * round-trip into Rust, and a fast typist would otherwise queue a walk per
 * keystroke.
 */
function ResourcePicker({ resourceKind, search, selectedId, onPick }: ResourcePickerProps) {
  const t = useTranslations("chat.composer.templateParams")
  const [query, setQuery] = useState("")
  const [state, setState] = useState<{ items: ResourceOption[]; loading: boolean }>({
    items: [],
    loading: true,
  })
  // Guards against an earlier, slower search landing after a later one and
  // repainting the list with results for a query the user has moved past.
  const latestQuery = useRef("")

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    latestQuery.current = query
    setState((prev) => ({ items: prev.items, loading: true }))
    const handle = window.setTimeout(() => {
      void search(resourceKind as never, query).then((items) => {
        if (latestQuery.current !== query) return
        setState({ items, loading: false })
      })
    }, 200)
    return () => window.clearTimeout(handle)
  }, [query, search, resourceKind])
  /* eslint-enable react-hooks/set-state-in-effect */

  const empty = useMemo(
    () => !state.loading && state.items.length === 0,
    [state.loading, state.items.length]
  )

  return (
    <div className="space-y-1.5">
      <Input
        value={query}
        autoFocus
        placeholder={t("searchPlaceholder")}
        data-testid="template-param-search"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="max-h-52 overflow-y-auto" role="listbox">
        {state.loading && state.items.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            {t("loading")}
          </div>
        ) : empty ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t("noMatches")}</p>
        ) : (
          state.items.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === selectedId}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                option.id === selectedId && "bg-accent/60"
              )}
              onClick={() => onPick(option)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.label !== option.raw ? (
                <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                  {option.raw}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
