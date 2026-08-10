import {
  ParameterDefinition,
  ProviderParameterSchema,
} from "@cognia/provider-types/provider-parameter-schema"
import { CustomProviderSettings } from "@cognia/provider-types/provider"

/**
 * Provider-specific parameter schema registry.
 *
 * Defines parameter definitions for each AI provider so the UI can
 * render appropriate controls and validate values dynamically.
 */

declare const COMMON_INFERENCE_PARAMETERS: ParameterDefinition[]
declare const COMMON_CONNECTION_PARAMETERS: ParameterDefinition[]
declare const PROVIDER_SCHEMAS: Record<string, ProviderParameterSchema>
/**
 * Returns the parameter schema for a given provider ID.
 *
 * Resolution order:
 * 1. Built-in schema from PROVIDER_SCHEMAS
 * 2. Custom provider — inherits from its apiProtocol schema, overriding id/name
 * 3. Unknown provider — returns inference + connection parameters only
 */
declare function getSchemaForProvider(
  providerId: string,
  customProviders?: Record<string, Pick<CustomProviderSettings, "apiProtocol" | "name">>
): ProviderParameterSchema

export {
  COMMON_CONNECTION_PARAMETERS,
  COMMON_INFERENCE_PARAMETERS,
  PROVIDER_SCHEMAS,
  getSchemaForProvider,
}
