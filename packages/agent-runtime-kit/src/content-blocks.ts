import type { AcpContentBlock, ExternalAgentContent } from "@cognia/agent-contracts/external-agent"

/** Preserve rich protocol content in collected results, not just streaming callbacks. */
export function externalContentFromBlock(block: AcpContentBlock): ExternalAgentContent {
  if (block.type === "image") {
    return {
      type: "image",
      source: { type: "base64", data: block.data, mediaType: block.mimeType },
    }
  }
  return block
}

/** Text-only consumers still get attachment identity without dumping binary bodies. */
export function contentBlocksText(blocks: readonly AcpContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return block.text
      if (block.type === "resource_link") return `[file: ${block.name} (${block.uri})]`
      if (block.type === "resource") {
        return "text" in block.resource ? block.resource.text : `[file: ${block.resource.uri}]`
      }
      return `[${block.type}: ${block.mimeType}]`
    })
    .join("")
}
