/**
 * The plugin contract's share of `lib/chat/template/resource-kinds.ts`, which re-exports these.
 */
import type { RESOURCE_PARAM_KINDS } from "@/lib/chat/template/resource-kinds"

export type ResourceParamKind = (typeof RESOURCE_PARAM_KINDS)[number]
