import type { VisualizationSpec } from "./model"

export function exportVisualizationSvg(spec: VisualizationSpec): Uint8Array {
  const max = Math.max(...spec.data.map((datum) => Math.abs(datum.value)), 1)
  const rows = spec.data
    .map((datum, index) => {
      const width = Math.max(2, (Math.abs(datum.value) / max) * 560)
      const y = 56 + index * Math.min(42, 260 / Math.max(spec.data.length, 1))
      const color = spec.palette[index % spec.palette.length]
      return `<text x="4" y="${y + 17}">${escapeXml(datum.label)}</text><rect x="130" y="${y}" width="${width}" height="24" fill="${escapeXml(color)}"/><text x="${138 + width}" y="${y + 17}">${datum.value}${escapeXml(spec.unit ?? "")}</text>`
    })
    .join("")
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(spec.accessibility.summary)}" viewBox="0 0 720 360"><title>${escapeXml(spec.title)}</title><text x="4" y="28" font-size="20" font-weight="700">${escapeXml(spec.title)}</text>${rows}</svg>`
  )
}

export function exportVisualizationHtml(spec: VisualizationSpec): Uint8Array {
  const rows = spec.data
    .map(
      (datum) =>
        `<tr><td>${escapeXml(datum.label)}</td><td>${datum.value}${escapeXml(spec.unit ?? "")}</td><td>${escapeXml(datum.group ?? "")}</td></tr>`
    )
    .join("")
  return new TextEncoder().encode(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeXml(spec.title)}</title><body><main><h1>${escapeXml(spec.title)}</h1><p>${escapeXml(spec.accessibility.summary)}</p><table><thead><tr><th>Label</th><th>Value</th><th>Group</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`
  )
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
