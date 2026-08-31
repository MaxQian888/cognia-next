import type { ShareProvenance } from "@/lib/share/types"
import { DIGITAL_TWIN_DISCLOSURE } from "@/lib/twin/outbound-disclosure"
import type { SingleExportFormat } from "./single"

function twinProvenance(provenance: readonly ShareProvenance[] | undefined) {
  return provenance?.filter((entry) => entry.source === "digital-twin") ?? []
}

/** Enforce visible and structured Digital Twin disclosure at the export sink. */
export function enforceExportDisclosure(
  content: string,
  format: SingleExportFormat,
  provenance: readonly ShareProvenance[] | undefined
): string {
  const twin = twinProvenance(provenance)
  if (twin.length === 0) return content
  const structured = JSON.stringify(twin)
  if (format === "html" || format === "animated") {
    const clean = content
      .replace(
        /<aside\b[^>]*data-cognia-provenance=["']digital-twin["'][^>]*>[\s\S]*?<\/aside>/gi,
        ""
      )
      .replace(/<script\b[^>]*data-cognia-provenance-json[^>]*>[\s\S]*?<\/script>/gi, "")
    const disclosure = `<aside data-cognia-provenance="digital-twin">${DIGITAL_TWIN_DISCLOSURE}</aside><script type="application/json" data-cognia-provenance-json>${structured.replaceAll("<", "\\u003c")}</script>`
    return clean.includes("</main>")
      ? clean.replace("</main>", `${disclosure}</main>`)
      : `${clean}\n${disclosure}`
  }
  if (format === "json") {
    try {
      const parsed = JSON.parse(content) as unknown
      const record =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { data: parsed }
      return JSON.stringify(
        {
          ...record,
          cogniaProvenance: twin,
          disclosure: DIGITAL_TWIN_DISCLOSURE,
        },
        null,
        2
      )
    } catch {
      throw new Error("Cannot enforce Digital Twin provenance on malformed JSON export")
    }
  }
  if (format === "jsonl" || format === "jsonl-chat") {
    const clean = content
      .split("\n")
      .filter((line) => {
        try {
          return (JSON.parse(line) as { type?: unknown }).type !== "cognia-provenance"
        } catch {
          return true
        }
      })
      .join("\n")
      .replace(/\s+$/, "")
    return `${clean}\n${JSON.stringify({
      type: "cognia-provenance",
      provenance: twin,
      disclosure: DIGITAL_TWIN_DISCLOSURE,
    })}`
  }
  const clean = content
    .split("\n")
    .filter(
      (line) => line.trim() !== DIGITAL_TWIN_DISCLOSURE && !line.startsWith("Cognia-Provenance:")
    )
    .join("\n")
    .replace(/\s+$/, "")
  return `${clean}\n\n${DIGITAL_TWIN_DISCLOSURE}\nCognia-Provenance: ${structured}\n`
}
