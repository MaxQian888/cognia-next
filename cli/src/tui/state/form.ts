/**
 * Guided argument-form state machine. Pure — drives the {@link FormOverlay}
 * component. Reuses the desktop `buildArgs` / `firstMissingRequired` so the
 * emitted args string matches exactly what the command handlers parse.
 */
import { buildArgs, firstMissingRequired } from "@/lib/slash-commands/build-args"

import type { CommandArgSpec } from "../commands/types"

export interface FormFieldState {
  spec: CommandArgSpec
  value: string
}

export interface FormOverlayState {
  title: string
  /** The command the collected args are submitted back to. */
  commandName: string
  subcommand?: string
  fields: FormFieldState[]
  activeField: number
  error?: string
}

export function createForm(
  specs: CommandArgSpec[],
  title: string,
  commandName: string,
  subcommand?: string
): FormOverlayState {
  return {
    title,
    commandName,
    subcommand,
    fields: specs.map((spec) => ({ spec, value: spec.default ?? "" })),
    activeField: 0,
  }
}

/** Set the active field's value, clearing any prior validation error. */
export function formSetValue(form: FormOverlayState, value: string): FormOverlayState {
  const fields = form.fields.map((f, i) => (i === form.activeField ? { ...f, value } : f))
  return { ...form, fields, error: undefined }
}

function moveField(form: FormOverlayState, delta: number): FormOverlayState {
  const len = form.fields.length
  if (len === 0) return form
  const next = (((form.activeField + delta) % len) + len) % len
  return { ...form, activeField: next }
}

export function formNextField(form: FormOverlayState): FormOverlayState {
  return moveField(form, 1)
}

export function formPrevField(form: FormOverlayState): FormOverlayState {
  return moveField(form, -1)
}

export type FormSubmitResult = { ok: true; args: string } | { ok: false; form: FormOverlayState }

/** Validate required fields and, when satisfied, emit the args string. */
export function formSubmit(form: FormOverlayState): FormSubmitResult {
  const specs = form.fields.map((f) => f.spec)
  const values = Object.fromEntries(form.fields.map((f) => [f.spec.name, f.value]))
  const missing = firstMissingRequired(specs, values)
  if (missing) {
    const idx = form.fields.findIndex((f) => f.spec.name === missing.name)
    return {
      ok: false,
      form: {
        ...form,
        activeField: idx >= 0 ? idx : form.activeField,
        error: `${missing.label} is required`,
      },
    }
  }
  return { ok: true, args: buildArgs(specs, values) }
}
