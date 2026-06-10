"use client"

/**
 * Host-rendered, data-driven dialog for the plugin `ctx.ui` API.
 *
 * `ctx.ui.showDialog` / `showInputDialog` / `showConfirmDialog` take plain
 * option objects (title / message / actions), not React components — so they
 * push THIS component onto the plugin modal stack (rendered by
 * `<PluginModalRoot />`, which already wraps each entry in a shadcn `Dialog` +
 * `DialogContent`). Previously those three methods used `window.prompt` /
 * `window.confirm`, which are unreliable in the Tauri / Capacitor shells.
 *
 * The caller passes a `settle(value)` callback in `args`; this component calls
 * it on the user's choice and, via an unmount-time cleanup, also settles with
 * the dismiss default when the user closes the dialog (click-outside / Esc).
 * `settle` is idempotent on the caller side, so action-then-unmount is safe.
 *
 * ADR-0026 §3 §A.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { PluginModalProps } from "@/types/plugin/plugin-modal"
import type { PluginDialog, PluginInputDialog, PluginConfirmDialog } from "@/types/plugin"

/** Discriminated payload passed through the modal store's `args`. */
export type PluginDataDialogArgs =
  | { kind: "dialog"; options: PluginDialog; settle: (value: unknown) => void }
  | { kind: "input"; options: PluginInputDialog; settle: (value: string | null) => void }
  | { kind: "confirm"; options: PluginConfirmDialog; settle: (value: boolean) => void }

/** Dismiss default per dialog kind — used when the user closes without acting. */
function dismissValue(kind: PluginDataDialogArgs["kind"]): unknown {
  switch (kind) {
    case "dialog":
      return undefined
    case "input":
      return null
    case "confirm":
      return false
  }
}

export function PluginDataDialog({ args, onClose }: PluginModalProps): React.ReactNode {
  // Reuse the shared `common.*` labels — the single-button / submit action maps
  // to "Confirm" since there is no separate "OK" key.
  const t = useTranslations("common")
  const data = args as PluginDataDialogArgs | undefined

  // Settle-on-dismiss: if the dialog unmounts (click-outside / Esc) before the
  // user picked an action, resolve the caller's promise with the dismiss
  // default so it never hangs. Guarded so an action-then-unmount can't double.
  const settledRef = useRef(false)
  const settle = (value: unknown): void => {
    if (settledRef.current || !data) return
    settledRef.current = true
    ;(data.settle as (v: unknown) => void)(value)
  }

  useEffect(() => {
    return () => {
      if (!settledRef.current && data) {
        settledRef.current = true
        ;(data.settle as (v: unknown) => void)(dismissValue(data.kind))
      }
    }
    // Run cleanup only on unmount; `data` is stable for a given modal entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [inputValue, setInputValue] = useState(
    data?.kind === "input" ? (data.options.defaultValue ?? "") : ""
  )
  const [inputError, setInputError] = useState<string | null>(null)

  if (!data) return null

  const close = (value: unknown): void => {
    settle(value)
    onClose()
  }

  if (data.kind === "confirm") {
    const { title, message, confirmLabel, cancelLabel, variant } = data.options
    return (
      <>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {cancelLabel ?? t("cancel")}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={() => close(true)}
          >
            {confirmLabel ?? t("confirm")}
          </Button>
        </DialogFooter>
      </>
    )
  }

  if (data.kind === "input") {
    const { title, message, placeholder, validate } = data.options
    const onSubmit = (): void => {
      if (validate) {
        const err = validate(inputValue)
        if (err) {
          setInputError(err)
          return
        }
      }
      close(inputValue)
    }
    return (
      <>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {message ? <DialogDescription>{message}</DialogDescription> : null}
        </DialogHeader>
        <Input
          autoFocus
          value={inputValue}
          placeholder={placeholder}
          aria-label={title}
          onChange={(e) => {
            setInputValue(e.target.value)
            if (inputError) setInputError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit()
          }}
        />
        {inputError ? <p className="text-sm text-destructive">{inputError}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => close(null)}>
            {t("cancel")}
          </Button>
          <Button onClick={onSubmit}>{t("confirm")}</Button>
        </DialogFooter>
      </>
    )
  }

  // kind === "dialog"
  const { title, content, actions } = data.options
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="text-sm">{content}</div>
      <DialogFooter>
        {actions && actions.length > 0 ? (
          actions.map((action, i) => (
            <Button
              key={i}
              variant={action.variant === "destructive" ? "destructive" : "default"}
              onClick={() => close(action.value)}
            >
              {action.label}
            </Button>
          ))
        ) : (
          <Button onClick={() => close(undefined)}>{t("confirm")}</Button>
        )}
      </DialogFooter>
    </>
  )
}
