"use client"

/**
 * Settings → Remote hosts → Add host (ADR-0082, R0).
 *
 * The form itself moved to `../add-host-form.tsx` when the `/devices` console
 * grew its own add-host sheet: the same pairing flow now has two entry points
 * and exactly one implementation. This tab is the Settings mount of it.
 */

import { AddHostForm, type AddHostFormProps } from "../add-host-form"

export type AddHostTabProps = Pick<AddHostFormProps, "onPaired" | "fetcher">

export function AddHostTab({ onPaired, fetcher }: AddHostTabProps) {
  return <AddHostForm onPaired={onPaired} fetcher={fetcher} />
}
