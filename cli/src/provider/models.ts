/**
 * `provider models`: the model inventory of one configured provider, through
 * the shared `models.list` operation. Catalog, models.dev and the provider's
 * own `/models` endpoint are merged, with `source` and `freshness` stated.
 * This is always answered locally: the inventory is a property of THIS
 * credential, and only this process holds it.
 */

import type { z } from "zod"
import type { modelsListOutput, ProviderOperationFailure } from "@cognia/provider-types"

import type { ResolvedConfig } from "../config/schema"
import type { CliProviderExecutor } from "./local"

export type ProviderModelsOutput = z.infer<typeof modelsListOutput>

export interface ProviderModelsReport {
  providerId: string
  listing?: ProviderModelsOutput
  failure?: ProviderOperationFailure
}

export interface ListModelsDeps {
  config: ResolvedConfig
  executor: CliProviderExecutor
  providerId?: string
  refresh?: boolean
  signal?: AbortSignal
}

export async function listProviderModels(deps: ListModelsDeps): Promise<ProviderModelsReport> {
  const providerId = deps.providerId ?? deps.config.provider
  const result = await deps.executor.execute<ProviderModelsOutput>(
    "models.list",
    providerId,
    deps.refresh ? { refresh: true } : {},
    deps.signal ? { signal: deps.signal } : {}
  )
  return result.ok ? { providerId, listing: result.output } : { providerId, failure: result }
}

/** One line per model: id, display name when it differs, context length. */
export function formatModelLine(model: ProviderModelsOutput["models"][number]): string {
  const name = model.name && model.name !== model.id ? `  ${model.name}` : ""
  const context = model.contextLength ? `  ${Math.round(model.contextLength / 1000)}k ctx` : ""
  return `${model.id}${name}${context}`
}
