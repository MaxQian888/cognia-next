/**
 * RTF Parser - Extract readable text from Rich Text Format content.
 */

export interface RTFParseResult {
  text: string
  metadata: RTFMetadata
}

export interface RTFMetadata {
  charset?: string
  controlWordCount: number
}

/**
 * Parse RTF text content.
 */
export function parseRTF(content: string): RTFParseResult {
  if (!content || typeof content !== "string") {
    throw new Error("Invalid RTF content.")
  }

  const charset = extractCharset(content)
  const controlWordMatches = content.match(/\\[a-zA-Z]+-?\d* ?/g)
  const controlWordCount = controlWordMatches?.length ?? 0

  let text = content

  // Convert common paragraph/line break control words to newlines first.
  text = text.replace(/\\par[d]?/gi, "\n").replace(/\\line/gi, "\n")

  // Decode hex escapes, e.g. \'e9.
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  )

  // Decode Unicode escapes, e.g. \u20320?.
  text = text.replace(/\\u(-?\d+)\??/g, (_, value: string) => {
    let code = Number(value)
    if (Number.isNaN(code)) return ""
    if (code < 0) code += 65536
    return String.fromCharCode(code)
  })

  // Remove escaped literal braces/backslashes.
  text = text.replace(/\\\\/g, "\\").replace(/\\\{/g, "{").replace(/\\\}/g, "}")

  // Remove remaining control words and groups.
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, "")
  text = text.replace(/[{}]/g, "")

  // Normalize whitespace.
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

  if (!text) {
    throw new Error("No readable text content found in RTF file.")
  }

  return {
    text,
    metadata: {
      charset,
      controlWordCount,
    },
  }
}

/**
 * Parse RTF content from File object.
 */
export async function parseRTFFile(file: File): Promise<RTFParseResult> {
  const content = await file.text()
  return parseRTF(content)
}

/**
 * Build embedding-friendly text from parsed RTF result.
 */
export function extractRTFEmbeddableContent(result: RTFParseResult): string {
  return result.text
}

function extractCharset(content: string): string | undefined {
  const match = content.match(/\\ansicpg(\d+)/i)
  return match ? `windows-${match[1]}` : undefined
}
