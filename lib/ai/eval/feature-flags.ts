const BUILD_EVAL_LAB_ENABLED = process.env.NEXT_PUBLIC_EVAL_LAB === "1"
const BUILD_LEGACY_ROLLBACK_ENABLED = process.env.NEXT_PUBLIC_EVAL_LEGACY_ROLLBACK === "1"

export function isEvalLabEnabled(environment?: Record<string, string | undefined>): boolean {
  if (!environment) return BUILD_EVAL_LAB_ENABLED && !BUILD_LEGACY_ROLLBACK_ENABLED
  return (
    environment.NEXT_PUBLIC_EVAL_LAB === "1" && environment.NEXT_PUBLIC_EVAL_LEGACY_ROLLBACK !== "1"
  )
}
