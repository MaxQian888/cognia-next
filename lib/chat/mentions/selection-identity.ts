/**
 * What makes two staged selections "the same reference".
 *
 * The chip bar used to append every staging unconditionally, so referencing one
 * issue from ⌘K after already picking it with `@issue:` sent its body twice, and
 * a multi-select that overlapped an earlier pick repeated whole turns. Staging
 * the same reference again now REPLACES the earlier chip (with the fresher
 * snapshot) instead of adding a second one.
 *
 * The identity is the thing pointed at, not the words captured from it: two
 * different excerpts of one page, or two different ranges of one file, are two
 * references. Pure, so the store and the chips agree on it.
 */

import type { ContextSelectionRef } from "@/types/artifact/artifact"
import { contentFingerprint } from "./content-fingerprint"

function rangeKey(range: { startLine: number; endLine: number } | undefined): string {
  return range ? `${range.startLine}-${range.endLine}` : "whole"
}

export function contextSelectionIdentity(selection: ContextSelectionRef): string {
  switch (selection.kind) {
    case "artifact":
      return [
        "artifact",
        selection.artifactId,
        rangeKey(selection.range),
        selection.element?.selector ?? "",
      ].join(":")
    case "file":
      return ["file", selection.relPath, rangeKey(selection.range)].join(":")
    case "web":
      // One page can be the source of several distinct excerpts.
      return ["web", selection.url, contentFingerprint(selection.snapshot)].join(":")
    case "comment":
      return [
        "comment",
        selection.title,
        selection.anchorLabel ?? "",
        contentFingerprint(selection.snapshot),
      ].join(":")
    case "external":
      return ["external", selection.candidateId].join(":")
    case "plugin":
      return ["plugin", selection.pluginId, selection.ref ?? selection.title].join(":")
    case "entity": {
      const members =
        selection.members && selection.members.length > 1
          ? selection.members.map((m) => m.entityId).join(",")
          : ""
      return ["entity", selection.entityKind, selection.entityId, members].join(":")
    }
  }
}
