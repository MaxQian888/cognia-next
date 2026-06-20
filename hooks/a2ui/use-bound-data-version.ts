import { useState } from "react"
import { getValueByPath } from "@/lib/a2ui/data-model"

/**
 * Returns a version number that only changes when one of the values resolved at
 * `paths` changes by reference (`Object.is`) between renders.
 *
 * This is the linchpin of fine-grained A2UI re-render skipping. The data model
 * uses structural sharing (see `lib/a2ui/data-model.ts`): a mutation to path X
 * produces new references only along the spine to X, leaving every other
 * subtree referentially identical. So a component that binds only to path Y can
 * resolve Y, see the same reference as last render, and keep a stable version,
 * which lets the renderer reuse its memoized props and skip the subtree even
 * though the surface's top-level `dataModel` reference changed.
 *
 * Implemented with the React-sanctioned "adjust state during render" pattern
 * (https://react.dev/reference/react/useState#storing-information-from-previous-renders):
 * when a bound value changed we set state during render, which React applies
 * immediately without committing the intermediate pass. The extra render only
 * happens for a component whose bound data actually changed (one that had to
 * re-render anyway), so unaffected components pay nothing.
 */
export function useBoundDataVersion(paths: string[], dataModel: Record<string, unknown>): number {
  const resolved = paths.map((path) => getValueByPath(dataModel, path))
  const [tracked, setTracked] = useState<{ values: unknown[]; version: number }>(() => ({
    values: resolved,
    version: 0,
  }))

  const changed =
    tracked.values.length !== resolved.length ||
    resolved.some((value, index) => !Object.is(value, tracked.values[index]))

  if (changed) {
    setTracked({ values: resolved, version: tracked.version + 1 })
    return tracked.version + 1
  }

  return tracked.version
}
