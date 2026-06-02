/** Foreign eval-format import dispatch. */

import type { ForeignFormat, ImportPreview } from "@/types/eval/import"
import type { MappingDeps } from "../field-mapping"
import { fromPromptfoo } from "./promptfoo"
import { fromOpenAiEvals } from "./openai-evals"
import { fromLangSmith } from "./langsmith"

export { fromPromptfoo } from "./promptfoo"
export { fromOpenAiEvals } from "./openai-evals"
export { fromLangSmith } from "./langsmith"

export function importForeign(
  format: ForeignFormat,
  raw: unknown,
  deps: MappingDeps
): ImportPreview {
  switch (format) {
    case "promptfoo":
      return fromPromptfoo(raw, deps)
    case "openai-evals":
      return fromOpenAiEvals(raw, deps)
    case "langsmith":
      return fromLangSmith(raw, deps)
    default: {
      const exhaustive: never = format
      throw new Error(`importForeign: unknown format ${String(exhaustive)}`)
    }
  }
}
