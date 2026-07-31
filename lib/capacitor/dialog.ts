"use client"

import { makeDefaultLoader, withPlugin } from "./_shared"

/**
 * `@capacitor/dialog` wrapper. Surfaces native alert / confirm / prompt
 * dialogs on mobile; falls back to web's `window.confirm` / `window.prompt`
 * when running outside the native shell so callers don't need a fork.
 */

interface DialogShape {
  alert(opts: { title?: string; message: string; buttonTitle?: string }): Promise<void>
  confirm(opts: {
    title?: string
    message: string
    okButtonTitle?: string
    cancelButtonTitle?: string
  }): Promise<{ value: boolean }>
  prompt(opts: {
    title?: string
    message: string
    okButtonTitle?: string
    cancelButtonTitle?: string
    inputPlaceholder?: string
    inputText?: string
  }): Promise<{ value: string; cancelled: boolean }>
}

export type DialogLoader = () => Promise<DialogShape>

const defaultLoader: DialogLoader = makeDefaultLoader<DialogShape>("@capacitor/dialog", "Dialog")

export interface AlertOptions {
  title?: string
  message: string
  buttonTitle?: string
  loader?: DialogLoader
}

export interface ConfirmOptions {
  title?: string
  message: string
  okText?: string
  cancelText?: string
  loader?: DialogLoader
}

export interface PromptOptions {
  title?: string
  message: string
  defaultValue?: string
  placeholder?: string
  okText?: string
  cancelText?: string
  loader?: DialogLoader
}

export type AlertOutcome =
  { kind: "shown" } | { kind: "unsupported" } | { kind: "error"; message: string }

export type ConfirmOutcome =
  | { kind: "confirmed" }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export type PromptOutcome =
  | { kind: "submitted"; value: string }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export async function alert(opts: AlertOptions): Promise<AlertOutcome> {
  const { title, message, buttonTitle, loader = defaultLoader } = opts
  const result = await withPlugin(loader, async (dialog) => {
    await dialog.alert({ title, message, buttonTitle })
    return { kind: "shown" as const }
  })
  return result
}

export async function confirm(opts: ConfirmOptions): Promise<ConfirmOutcome> {
  const { title, message, okText, cancelText, loader = defaultLoader } = opts
  const result = await withPlugin(loader, async (dialog) => {
    const { value } = await dialog.confirm({
      title,
      message,
      okButtonTitle: okText,
      cancelButtonTitle: cancelText,
    })
    return value ? { kind: "confirmed" as const } : { kind: "cancelled" as const }
  })
  return result
}

export async function prompt(opts: PromptOptions): Promise<PromptOutcome> {
  const {
    title,
    message,
    defaultValue,
    placeholder,
    okText,
    cancelText,
    loader = defaultLoader,
  } = opts
  const result = await withPlugin(loader, async (dialog) => {
    const res = await dialog.prompt({
      title,
      message,
      okButtonTitle: okText,
      cancelButtonTitle: cancelText,
      inputPlaceholder: placeholder,
      inputText: defaultValue,
    })
    if (res.cancelled) return { kind: "cancelled" as const }
    return { kind: "submitted" as const, value: res.value }
  })
  return result
}
