"use client"

/**
 * What the migration wizard used to throw away.
 *
 * Every importer under `lib/agent-migration/artifacts.ts` returns warnings, and
 * the wizard rendered a status badge and an item count next to them. So a run
 * that skipped nine of ten commands because their frontmatter did not parse
 * reported "10 items" and then "0 imported", with the ten reasons computed and
 * discarded.
 *
 * `error` is deliberately not rendered. `MigrationArtifactResult.error` carries
 * a raw exception message from whichever layer threw, which can be a filesystem
 * path or database detail, and
 * `components/agent-migration/agent-migration-dialog.test.tsx` pins that it
 * stays out of the UI. The caller logs it instead. Warnings are different:
 * every one is a sentence this codebase wrote for a person to read.
 */

import { useTranslations } from "next-intl"

import { FidelitySummary } from "@/components/common/fidelity-summary"
import type { MigrationArtifactStatus } from "@/lib/agent-migration/types"

/** Statuses that mean "nothing was imported, and here is why". */
const EXPLAINED: readonly MigrationArtifactStatus[] = ["shared", "empty", "unsupported", "error"]

/** How many warnings to show before folding the rest into a count. */
const MAX_WARNINGS = 6

export interface ArtifactWarningsProps {
  status: MigrationArtifactStatus
  warnings: readonly string[]
  testId?: string
}

export function ArtifactWarnings({ status, warnings, testId }: ArtifactWarningsProps) {
  const t = useTranslations("agentMigration")
  const explanation = EXPLAINED.includes(status) ? t(`explain.${status}`) : null

  if (!explanation && warnings.length === 0) return null

  return (
    <FidelitySummary
      testId={testId ?? "artifact-warnings"}
      title={t("warnings.title")}
      hints={explanation ? [explanation] : []}
      entries={warnings.map((warning, index) => ({ id: `${index}-${warning}`, label: warning }))}
      emptyLabel=""
      maxEntries={MAX_WARNINGS}
      moreLabel={(hidden) => t("warnings.more", { count: hidden })}
    />
  )
}
