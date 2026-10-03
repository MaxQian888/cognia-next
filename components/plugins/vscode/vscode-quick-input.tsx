"use client"

/**
 * A VS Code extension's quick pick or input box, opened in the plugin modal
 * stack by the window presenter. The extension host owns the state (items,
 * value, busy, validation …) and this draws it from `window-ui-store`,
 * reporting every keystroke, move, selection, accept and button back.
 * Dismissing the modal (Escape, clicking outside) is reported as a hide.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { dismissQuickInput, sendQuickInputEvent } from "@/lib/plugin/vscode-shim/window-handlers"
import {
  filterQuickPickItems,
  getQuickInputSession,
  getVscodeWindowRevision,
  subscribeVscodeWindow,
  updateQuickInputSession,
  type QuickInputButtonState,
  type QuickInputSession,
} from "@/lib/plugin/vscode-shim/window-ui-store"
import { cn } from "@/lib/utils"
import type { PluginModalProps } from "@/types/plugin/plugin-modal"

import { CodiconIcon, CodiconLabel } from "./codicon-label"
import { useExtensionName } from "./use-extension-name"

function useSession(sessionId: string): QuickInputSession | undefined {
  useSyncExternalStore(subscribeVscodeWindow, getVscodeWindowRevision, getVscodeWindowRevision)
  return getQuickInputSession(sessionId)
}

function HeaderButtons({
  buttons,
  onTrigger,
}: {
  buttons: QuickInputButtonState[]
  onTrigger: (index: number) => void
}) {
  if (buttons.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {buttons.map((button, index) => (
        <Tooltip key={index}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={button.tooltip ?? button.icon ?? String(index + 1)}
              onClick={() => onTrigger(index)}
            >
              {button.icon ? <CodiconIcon name={button.icon} /> : index + 1}
            </Button>
          </TooltipTrigger>
          {button.tooltip ? <TooltipContent>{button.tooltip}</TooltipContent> : null}
        </Tooltip>
      ))}
    </div>
  )
}

function Header({
  session,
  onButton,
}: {
  session: QuickInputSession
  onButton: (index: number) => void
}) {
  const t = useTranslations("plugins.vscodeWindow.quickInput")
  const { title, step, totalSteps, busy, buttons } = session.state
  const stepText =
    step !== undefined
      ? totalSteps !== undefined
        ? t("step", { step, total: totalSteps })
        : t("stepOnly", { step })
      : undefined
  if (!title && !stepText && !busy && !buttons?.length) return null
  return (
    <div className="flex items-center gap-2 border-b py-2 pr-10 pl-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {title ? <span className="truncate text-sm font-medium">{title}</span> : null}
        {stepText ? (
          <span className="text-muted-foreground shrink-0 text-xs">{stepText}</span>
        ) : null}
      </div>
      {busy ? <Spinner className="size-4" aria-label={t("working")} /> : null}
      <HeaderButtons buttons={buttons ?? []} onTrigger={onButton} />
    </div>
  )
}

function QuickPickBody({ session }: { session: QuickInputSession }) {
  const t = useTranslations("plugins.vscodeWindow.quickInput")
  const extension = useExtensionName(session.pluginId)
  const { state, sessionId, pluginId } = session
  const items = useMemo(() => state.items ?? [], [state.items])
  const query = state.value ?? ""
  const visible = useMemo(
    () =>
      filterQuickPickItems(items, query, {
        matchOnDescription: state.matchOnDescription,
        matchOnDetail: state.matchOnDetail,
        sortByLabel: state.sortByLabel,
      }),
    [items, query, state.matchOnDescription, state.matchOnDetail, state.sortByLabel]
  )
  const many = state.canSelectMany === true
  const selected = new Set(state.selectedIndices ?? [])
  const firstVisibleItem = visible.find((index) => !items[index]?.separator)
  const active = state.activeIndices?.find((index) => visible.includes(index)) ?? firstVisibleItem
  const send = (event: unknown) => sendQuickInputEvent(pluginId, sessionId, event)

  const setValue = (value: string) => {
    updateQuickInputSession(sessionId, { value })
    send({ type: "value", value })
  }
  const setActive = (key: string) => {
    const index = Number(key)
    if (!Number.isInteger(index) || index === active) return
    updateQuickInputSession(sessionId, { activeIndices: [index] })
    send({ type: "active", indices: [index] })
  }
  const toggle = (index: number) => {
    const next = selected.has(index)
      ? [...selected].filter((entry) => entry !== index)
      : [...selected, index]
    updateQuickInputSession(sessionId, { selectedIndices: next })
    send({ type: "selection", indices: next })
  }
  const accept = (index?: number) => {
    if (state.enabled === false) return
    if (many) send({ type: "accept" })
    else if (index !== undefined) send({ type: "accept", selected: [index] })
  }

  return (
    <Command
      shouldFilter={false}
      value={active !== undefined ? String(active) : ""}
      onValueChange={setActive}
      aria-label={t("ariaPick", { extension })}
      onKeyDown={(event) => {
        // In a multi-select, Enter accepts and Space toggles, as in VS Code.
        if (!many) return
        if (event.key === "Enter") {
          event.preventDefault()
          accept()
        } else if (
          event.key === " " &&
          active !== undefined &&
          event.target === event.currentTarget
        ) {
          event.preventDefault()
          toggle(active)
        }
      }}
    >
      <CommandInput
        value={query}
        onValueChange={setValue}
        placeholder={state.placeholder ?? t("filterPlaceholder")}
        disabled={state.enabled === false}
        autoFocus
      />
      <CommandList className="max-h-80">
        <CommandEmpty>{t("noResults")}</CommandEmpty>
        {visible.map((index) => {
          const item = items[index]
          if (!item) return null
          if (item.separator) {
            return (
              <div key={`sep-${index}`}>
                <CommandSeparator />
                {item.label ? (
                  <div className="text-muted-foreground px-2 pt-2 pb-1 text-xs">{item.label}</div>
                ) : null}
              </div>
            )
          }
          return (
            <CommandItem
              key={index}
              value={String(index)}
              disabled={state.enabled === false}
              onSelect={() => (many ? toggle(index) : accept(index))}
              className="group flex items-start gap-2"
            >
              {many ? (
                <Checkbox
                  checked={selected.has(index)}
                  tabIndex={-1}
                  aria-hidden
                  className="mt-0.5"
                />
              ) : null}
              {item.icon ? <CodiconIcon name={item.icon} className="mt-0.5" /> : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <CodiconLabel label={item.label} className="truncate" />
                  {item.description ? (
                    <span className="text-muted-foreground truncate text-xs">
                      <CodiconLabel label={item.description} />
                    </span>
                  ) : null}
                </div>
                {item.detail ? (
                  <div className="text-muted-foreground truncate text-xs">
                    <CodiconLabel label={item.detail} />
                  </div>
                ) : null}
              </div>
              {item.buttons?.length ? (
                <div className="flex items-center gap-1 opacity-0 group-data-[selected=true]:opacity-100">
                  {item.buttons.map((button, buttonIndex) => (
                    <Button
                      key={buttonIndex}
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label={button.tooltip ?? button.icon ?? String(buttonIndex + 1)}
                      title={button.tooltip}
                      onClick={(event) => {
                        event.stopPropagation()
                        send({ type: "itemButton", item: index, button: buttonIndex })
                      }}
                    >
                      {button.icon ? <CodiconIcon name={button.icon} /> : buttonIndex + 1}
                    </Button>
                  ))}
                </div>
              ) : null}
            </CommandItem>
          )
        })}
      </CommandList>
      <div className="text-muted-foreground flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
        <span>{many ? t("selectedCount", { count: selected.size }) : t("hint")}</span>
        {many ? (
          <Button
            type="button"
            size="sm"
            onClick={() => accept()}
            disabled={state.enabled === false}
          >
            {t("ok")}
          </Button>
        ) : null}
      </div>
    </Command>
  )
}

const SEVERITY_CLASS: Record<number, string> = {
  1: "text-muted-foreground",
  2: "text-amber-600 dark:text-amber-400",
  3: "text-destructive",
}

function InputBoxBody({ session }: { session: QuickInputSession }) {
  const t = useTranslations("plugins.vscodeWindow.quickInput")
  const extension = useExtensionName(session.pluginId)
  const { state, sessionId, pluginId } = session
  const inputRef = useRef<HTMLInputElement>(null)
  const [selectionApplied, setSelectionApplied] = useState(false)
  const send = (event: unknown) => sendQuickInputEvent(pluginId, sessionId, event)
  const validation = state.validationMessage

  useEffect(() => {
    // Place the extension's `valueSelection` once, when the box first shows.
    if (selectionApplied || !inputRef.current) return
    const [start, end] = state.valueSelection ?? [0, (state.value ?? "").length]
    inputRef.current.setSelectionRange(start, end)
    setSelectionApplied(true)
  }, [selectionApplied, state.valueSelection, state.value])

  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (state.enabled !== false) send({ type: "accept" })
      }}
    >
      <Input
        ref={inputRef}
        autoFocus
        type={state.password ? "password" : "text"}
        value={state.value ?? ""}
        placeholder={state.placeholder}
        disabled={state.enabled === false}
        aria-label={state.prompt ?? t("ariaInput", { extension })}
        aria-invalid={validation?.severity === 3 || undefined}
        onChange={(event) => {
          const value = event.target.value
          updateQuickInputSession(sessionId, { value })
          send({ type: "value", value })
        }}
      />
      {validation ? (
        <p
          role="alert"
          className={cn("text-xs", SEVERITY_CLASS[validation.severity] ?? SEVERITY_CLASS[3])}
        >
          {validation.message}
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">{state.prompt ?? t("hint")}</p>
    </form>
  )
}

export function VscodeQuickInput({ args }: PluginModalProps) {
  const sessionId = String(args?.sessionId ?? "")
  const session = useSession(sessionId)

  useEffect(
    () => () => {
      // Unmounted while the extension still has it open: the user dismissed it.
      if (getQuickInputSession(sessionId)) dismissQuickInput(sessionId)
    },
    [sessionId]
  )

  if (!session) return null
  const onButton = (index: number) =>
    sendQuickInputEvent(session.pluginId, sessionId, { type: "button", index })
  return (
    <div data-testid="vscode-quick-input" className="-m-6 flex flex-col overflow-hidden">
      <Header session={session} onButton={onButton} />
      {session.kind === "pick" ? (
        <QuickPickBody session={session} />
      ) : (
        <InputBoxBody session={session} />
      )}
    </div>
  )
}
