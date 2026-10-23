import type { InboundA2UINode } from "@cognia/plugin-contract/lib/connectors/adapters/_shared/inbound-a2ui-types"
export type {
  InboundA2UIBlock,
  InboundA2UINode,
} from "@cognia/plugin-contract/lib/connectors/adapters/_shared/inbound-a2ui-types"

/** Helper used by mappers to chain children safely without arrays-of-arrays. */
export function flatten(
  nodes: Array<InboundA2UINode | InboundA2UINode[] | null | undefined>
): InboundA2UINode[] {
  const out: InboundA2UINode[] = []
  for (const node of nodes) {
    if (!node) continue
    if (Array.isArray(node)) out.push(...node)
    else out.push(node)
  }
  return out
}
