import type { ShareProvenance } from "@/lib/share/types"
import type { MessageSegment } from "@/types/connectors/segment"
import type { OutboundRequest } from "@/types/connectors/outbound"

export const DIGITAL_TWIN_DISCLOSURE = "[AI-generated · Digital Twin]"

export function twinShareProvenance(twinId: string): ShareProvenance[] {
  return [{ source: "digital-twin", sourceId: twinId, disclosure: "ai-generated" }]
}

export function discloseTwinOutboundSegments(
  segments: readonly MessageSegment[],
  twinId: string
): { segments: MessageSegment[]; provenance: ShareProvenance[] } {
  const disclosed = segments.map((segment) => ({ ...segment }))
  const alreadyVisible = disclosed.some(
    (segment) =>
      (segment.type === "text" && segment.text.includes(DIGITAL_TWIN_DISCLOSURE)) ||
      (segment.type === "markdown" && segment.md.includes(DIGITAL_TWIN_DISCLOSURE))
  )
  if (!alreadyVisible) {
    const last = disclosed.at(-1)
    if (last?.type === "markdown") last.md = `${last.md}\n\n${DIGITAL_TWIN_DISCLOSURE}`
    else if (last?.type === "text") last.text = `${last.text}\n\n${DIGITAL_TWIN_DISCLOSURE}`
    else disclosed.push({ type: "text", text: DIGITAL_TWIN_DISCLOSURE })
  }
  return { segments: disclosed, provenance: twinShareProvenance(twinId) }
}

/** Re-assert the visible marker from host-owned structured provenance. */
export function enforceTwinDisclosureFromProvenance(
  segments: readonly MessageSegment[],
  provenance: OutboundRequest["metadata"]["provenance"]
): MessageSegment[] {
  const twin = provenance?.find((entry) => entry.source === "digital-twin")
  return twin ? discloseTwinOutboundSegments(segments, twin.sourceId).segments : [...segments]
}
