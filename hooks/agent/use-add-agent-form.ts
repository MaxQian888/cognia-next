"use client"

/**
 * State for an "add external agent" form: the picked preset, the fields, and
 * the process environment as editable rows.
 *
 * The rules (what a preset implies, what is invalid, what gets stored) are in
 * `lib/ai/agent/external/config/add-agent-form.ts`; this hook only holds the
 * values the user is editing and turns them into a submission. Where the
 * submission goes — this machine's store, or the paired Host — is the caller's.
 */

import { useCallback, useMemo, useState } from "react"

import { kvRowsToObject, objectToKvRows } from "@/components/settings/mcp/mcp-server-utils"
import {
  DEFAULT_ADD_AGENT_FORM_DATA,
  addAgentFormForPreset,
  addAgentFormShape,
  validateAddAgentForm,
  type AddAgentFormProblem,
  type AddAgentFormSeed,
  type AddAgentFormShape,
} from "@/lib/ai/agent/external/config/add-agent-form"
import type { AddAgentFormData } from "@/types/agent/component-types"

type KvRow = ReturnType<typeof objectToKvRows>[number]

export interface AddAgentFormState {
  presetId: string
  data: AddAgentFormData
  setData: React.Dispatch<React.SetStateAction<AddAgentFormData>>
  /** Shallow field update, the common case for an input's `onChange`. */
  setField: <K extends keyof AddAgentFormData>(key: K, value: AddAgentFormData[K]) => void
  processEnvRows: KvRow[]
  setProcessEnvRows: (rows: KvRow[]) => void
  shape: AddAgentFormShape
  /** Pick a preset (or `"custom"`), seeding every field it implies. */
  applyPreset: (presetId: string) => void
  /**
   * Check the form and, when it is valid, return the data to submit: names and
   * endpoints trimmed, the environment rows folded into `processEnv`, and the
   * preset recorded.
   */
  prepare: () => { ok: true; data: AddAgentFormData } | { ok: false; problem: AddAgentFormProblem }
  reset: () => void
}

/**
 * @param initialPresetId the preset an "add" form starts from.
 * @param seed an existing configuration's fields (`addAgentFormFromConfig`),
 *   for a screen that edits a configuration with the same form. Read once, on
 *   mount: remount (a `key`) to start over from a different configuration.
 */
export function useAddAgentForm(initialPresetId = "", seed?: AddAgentFormSeed): AddAgentFormState {
  // Read once: both the fields and the rows below are initial state.
  const [seeded] = useState(
    () => seed ?? addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, initialPresetId)
  )
  const [presetId, setPresetId] = useState(seed?.presetId ?? initialPresetId)
  const [data, setData] = useState<AddAgentFormData>(
    () => seeded?.data ?? DEFAULT_ADD_AGENT_FORM_DATA
  )
  const [processEnvRows, setProcessEnvRows] = useState<KvRow[]>(() =>
    objectToKvRows(seeded?.processEnv ?? {})
  )

  const setField = useCallback(
    <K extends keyof AddAgentFormData>(key: K, value: AddAgentFormData[K]) =>
      setData((current) => ({ ...current, [key]: value })),
    []
  )

  const applyPreset = useCallback(
    (next: string) => {
      setPresetId(next)
      const applied = addAgentFormForPreset(data, next)
      if (!applied) return
      setData(applied.data)
      setProcessEnvRows(objectToKvRows(applied.processEnv))
    },
    [data]
  )

  const shape = useMemo(() => addAgentFormShape(data, presetId), [data, presetId])

  const prepare = useCallback((): ReturnType<AddAgentFormState["prepare"]> => {
    const processEnv = kvRowsToObject(processEnvRows)
    const problem = validateAddAgentForm(data, presetId, {
      names: processEnvRows.map((row) => row.key),
      values: processEnv,
    })
    if (problem) return { ok: false, problem }
    return {
      ok: true,
      data: {
        ...data,
        processEnv,
        preset: presetId || undefined,
        name: data.name.trim(),
        command: data.command.trim(),
        endpoint: data.endpoint.trim(),
      },
    }
  }, [data, presetId, processEnvRows])

  const reset = useCallback(() => {
    setPresetId("")
    setData(DEFAULT_ADD_AGENT_FORM_DATA)
    setProcessEnvRows([])
  }, [])

  return {
    presetId,
    data,
    setData,
    setField,
    processEnvRows,
    setProcessEnvRows,
    shape,
    applyPreset,
    prepare,
    reset,
  }
}
