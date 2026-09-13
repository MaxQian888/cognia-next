import type { VisualizationSpec } from "./model"

/**
 * Pure-string SVG chart builders shared by the artifact preview (which inlines
 * the markup) and the standalone SVG/HTML exporters (which serialize it as
 * bytes). Kept DOM-free so `visualize_export` also works in the headless
 * runtime and under node-run unit tests.
 *
 * `fill="currentColor"` on every text node keeps labels legible in dark mode:
 * inside the host, `color` inherits `var(--foreground)`; standalone exports
 * set an explicit `color` on the root `<svg>`.
 */

const WIDTH = 720
const HEIGHT = 400
const PLOT_LEFT = 132
const PLOT_RIGHT = 688
const PALETTE_FALLBACK = "#2563eb"

export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function color(spec: VisualizationSpec, index: number): string {
  return spec.palette[index % spec.palette.length] ?? PALETTE_FALLBACK
}

function svgWrap(
  spec: VisualizationSpec,
  body: string,
  opts: { height?: number; standalone?: boolean } = {}
): string {
  const height = opts.height ?? HEIGHT
  const colorStyle = opts.standalone ? ` style="color:#0f172a"` : ""
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" ` +
    `role="img" aria-label="${escapeXml(spec.accessibility.summary)}"${colorStyle}>` +
    `<title>${escapeXml(spec.title)}</title>${body}</svg>`
  )
}

function text(
  x: number,
  y: number,
  content: string,
  attrs: {
    anchor?: "start" | "middle" | "end"
    size?: number
    weight?: number
    opacity?: number
  } = {}
): string {
  const anchor = attrs.anchor ? ` text-anchor="${attrs.anchor}"` : ""
  const size = attrs.size ? ` font-size="${attrs.size}"` : ` font-size="12"`
  const weight = attrs.weight ? ` font-weight="${attrs.weight}"` : ""
  const opacity = attrs.opacity !== undefined ? ` opacity="${attrs.opacity}"` : ""
  return `<text x="${x}" y="${y}"${size}${weight}${anchor}${opacity} fill="currentColor">${escapeXml(content)}</text>`
}

function extent(values: number[]): { lo: number; hi: number } {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 }
  return { lo: Math.min(lo, 0), hi: hi === lo ? lo + 1 : hi }
}

// ---------------------------------------------------------------------------
// Bars (bar, histogram) — sign-aware horizontal bars with a zero axis.
// ---------------------------------------------------------------------------

function barsSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const { lo, hi } = extent(spec.data.map((d) => d.value))
  const span = hi - lo || 1
  const x = (v: number) => PLOT_LEFT + ((v - lo) / span) * (PLOT_RIGHT - PLOT_LEFT)
  const zero = x(0)
  const n = Math.max(spec.data.length, 1)
  const rowH = Math.min(44, (HEIGHT - 64) / n)
  let body = `<line x1="${zero}" y1="24" x2="${zero}" y2="${HEIGHT - 24}" stroke="currentColor" opacity="0.25"/>`
  spec.data.forEach((datum, index) => {
    const y = 32 + index * rowH
    const barH = Math.max(6, rowH * 0.62)
    const x1 = Math.min(x(datum.value), zero)
    const w = Math.max(2, Math.abs(x(datum.value) - zero))
    const valueX = datum.value >= 0 ? Math.min(x1 + w + 6, PLOT_RIGHT) : Math.max(x1 - 6, PLOT_LEFT)
    body +=
      `<rect x="${x1}" y="${y}" width="${w}" height="${barH}" rx="3" fill="${escapeXml(color(spec, index))}"/>` +
      text(4, y + barH / 2 + 4, truncate(datum.label, 16)) +
      text(valueX, y + barH / 2 + 4, `${fmt(datum.value)}${spec.unit ?? ""}`, {
        anchor: datum.value >= 0 ? "start" : "end",
        weight: 600,
      })
  })
  return svgWrap(spec, body, opts)
}

/** Funnel: stages keep their declared order; widths are centered and shrink. */
function funnelSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const max = Math.max(...spec.data.map((d) => Math.abs(d.value)), 1)
  const n = Math.max(spec.data.length, 1)
  const rowH = Math.min(56, (HEIGHT - 56) / n)
  const center = WIDTH / 2
  let body = ""
  spec.data.forEach((datum, index) => {
    const y = 24 + index * rowH
    const w = Math.max(24, (Math.abs(datum.value) / max) * 560)
    const barH = Math.max(10, rowH - 8)
    body +=
      `<rect x="${center - w / 2}" y="${y}" width="${w}" height="${barH}" rx="4" fill="${escapeXml(color(spec, index))}"/>` +
      text(center, y + barH / 2 + 4, truncate(datum.label, 24), {
        anchor: "middle",
        weight: 600,
        opacity: w > 180 ? 1 : 0,
      }) +
      text(center + w / 2 + 8, y + barH / 2 + 4, `${fmt(datum.value)}${spec.unit ?? ""}`, {
        weight: 600,
      })
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Line / area / simulation — ordered points over index (or x when present).
// ---------------------------------------------------------------------------

function lineSvg(spec: VisualizationSpec, filled: boolean, opts: { standalone?: boolean }): string {
  const values = spec.data.map((d) => d.value)
  const { lo, hi } = extent(values)
  const span = hi - lo || 1
  const n = spec.data.length
  const px = (i: number) =>
    PLOT_LEFT + (n > 1 ? (i / (n - 1)) * (PLOT_RIGHT - PLOT_LEFT) : (PLOT_RIGHT - PLOT_LEFT) / 2)
  const py = (v: number) => HEIGHT - 48 - ((v - lo) / span) * (HEIGHT - 96)
  const points = spec.data.map((d, i) => `${px(i)},${py(d.value)}`).join(" ")
  const baseY = py(Math.max(lo, 0))
  let body = `<line x1="${PLOT_LEFT}" y1="${baseY}" x2="${PLOT_RIGHT}" y2="${baseY}" stroke="currentColor" opacity="0.25"/>`
  if (filled && n > 1)
    body += `<polygon points="${PLOT_LEFT},${baseY} ${points} ${PLOT_RIGHT},${baseY}" fill="${escapeXml(color(spec, 0))}" opacity="0.18"/>`
  if (n > 1)
    body += `<polyline points="${points}" fill="none" stroke="${escapeXml(color(spec, 0))}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
  const labelEvery = Math.max(1, Math.ceil(n / 12))
  spec.data.forEach((d, i) => {
    body += `<circle cx="${px(i)}" cy="${py(d.value)}" r="3.5" fill="${escapeXml(color(spec, i))}"/>`
    if (i % labelEvery === 0)
      body += text(px(i), HEIGHT - 24, truncate(d.label, 10), {
        anchor: "middle",
        size: 11,
        opacity: 0.75,
      })
  })
  body += text(PLOT_LEFT, 36, `${fmt(hi)}${spec.unit ?? ""}`, { size: 11, opacity: 0.6 })
  body += text(PLOT_LEFT, HEIGHT - 44, `${fmt(lo)}${spec.unit ?? ""}`, { size: 11, opacity: 0.6 })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Scatter / map — x/y positioned points colored by group.
// ---------------------------------------------------------------------------

function scatterSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const xs = spec.data.map((d, i) => d.x ?? i)
  const ys = spec.data.map((d) => d.y ?? d.value)
  const xe = extent(xs)
  const ye = extent(ys)
  const px = (v: number) =>
    PLOT_LEFT + ((v - xe.lo) / (xe.hi - xe.lo || 1)) * (PLOT_RIGHT - PLOT_LEFT)
  const py = (v: number) => HEIGHT - 48 - ((v - ye.lo) / (ye.hi - ye.lo || 1)) * (HEIGHT - 96)
  const groups = [...new Set(spec.data.map((d) => d.group ?? ""))]
  let body =
    `<line x1="${PLOT_LEFT}" y1="${HEIGHT - 48}" x2="${PLOT_RIGHT}" y2="${HEIGHT - 48}" stroke="currentColor" opacity="0.25"/>` +
    `<line x1="${PLOT_LEFT}" y1="48" x2="${PLOT_LEFT}" y2="${HEIGHT - 48}" stroke="currentColor" opacity="0.25"/>`
  spec.data.forEach((d, i) => {
    const cx = px(xs[i])
    const cy = py(ys[i])
    body += `<circle cx="${cx}" cy="${cy}" r="6" fill="${escapeXml(color(spec, Math.max(groups.indexOf(d.group ?? ""), 0)))}" opacity="0.85"><title>${escapeXml(d.label)}: ${fmt(d.value)}${escapeXml(spec.unit ?? "")}</title></circle>`
  })
  if (groups.length > 1) {
    groups.forEach((g, i) => {
      body +=
        `<rect x="${PLOT_LEFT + i * 120}" y="${HEIGHT - 26}" width="10" height="10" rx="2" fill="${escapeXml(color(spec, i))}"/>` +
        text(PLOT_LEFT + i * 120 + 14, HEIGHT - 17, truncate(g, 14), { size: 11, opacity: 0.8 })
    })
  }
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Pie / donut — proportional arcs + legend.
// ---------------------------------------------------------------------------

function pieSvg(spec: VisualizationSpec, donut: boolean, opts: { standalone?: boolean }): string {
  const slices = spec.data.map((d) => Math.max(0, d.value))
  let total = slices.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    slices.fill(1)
    total = slices.length
  }
  const cx = 190
  const cy = 200
  const r = 140
  const inner = donut ? 78 : 0
  let angle = -Math.PI / 2
  let body = ""
  const point = (a: number, radius: number) =>
    `${cx + Math.cos(a) * radius},${cy + Math.sin(a) * radius}`
  spec.data.forEach((d, i) => {
    const sweep = (slices[i] / total) * Math.PI * 2
    const a1 = angle + sweep
    const large = sweep > Math.PI ? 1 : 0
    const c = escapeXml(color(spec, i))
    if (sweep >= Math.PI * 2 - 1e-6) {
      body += donut
        ? `<circle cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" stroke="${c}" stroke-width="${r - inner}"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`
    } else if (donut) {
      body += `<path d="M${point(angle, inner)} L${point(angle, r)} A${r},${r} 0 ${large} 1 ${point(a1, r)} L${point(a1, inner)} A${inner},${inner} 0 ${large} 0 ${point(angle, inner)} Z" fill="${c}"/>`
    } else {
      body += `<path d="M${cx},${cy} L${point(angle, r)} A${r},${r} 0 ${large} 1 ${point(a1, r)} Z" fill="${c}"/>`
    }
    angle = a1
    const ly = 96 + i * 24
    body +=
      `<rect x="380" y="${ly - 10}" width="12" height="12" rx="2" fill="${c}"/>` +
      text(
        398,
        ly,
        `${truncate(d.label, 20)} — ${fmt(d.value)}${spec.unit ?? ""} (${Math.round((slices[i] / total) * 100)}%)`
      )
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Radar — one axis per datum, polygon through normalized values.
// ---------------------------------------------------------------------------

function radarSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const n = spec.data.length
  const cx = WIDTH / 2
  const cy = 205
  const r = 140
  const max = Math.max(...spec.data.map((d) => Math.abs(d.value)), 1)
  const angle = (i: number) => -Math.PI / 2 + (i / Math.max(n, 3)) * Math.PI * 2
  const point = (i: number, ratio: number) =>
    `${cx + Math.cos(angle(i)) * r * ratio},${cy + Math.sin(angle(i)) * r * ratio}`
  let body = ""
  for (const ring of [1 / 3, 2 / 3, 1]) {
    const ringPoints = spec.data.map((_, i) => point(i, ring)).join(" ")
    if (n > 2)
      body += `<polygon points="${ringPoints}" fill="none" stroke="currentColor" opacity="0.15"/>`
  }
  spec.data.forEach((d, i) => {
    body +=
      `<line x1="${cx}" y1="${cy}" x2="${point(i, 1)}" stroke="currentColor" opacity="0.2"/>` +
      text(
        cx + Math.cos(angle(i)) * (r + 22),
        cy + Math.sin(angle(i)) * (r + 22) + 4,
        truncate(d.label, 12),
        { anchor: "middle", size: 11 }
      )
  })
  if (n > 2) {
    const poly = spec.data.map((d, i) => point(i, Math.abs(d.value) / max)).join(" ")
    body += `<polygon points="${poly}" fill="${escapeXml(color(spec, 0))}" opacity="0.25" stroke="${escapeXml(color(spec, 0))}" stroke-width="2"/>`
  }
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Gauge — semicircle arc scaled to the largest value.
// ---------------------------------------------------------------------------

function gaugeSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const datum = spec.data[0]
  const value = datum?.value ?? 0
  const max = Math.max(...spec.data.map((d) => Math.abs(d.value)), Math.abs(value), 1)
  const ratio = Math.min(Math.abs(value) / max, 1)
  const cx = WIDTH / 2
  const cy = 300
  const r = 190
  const point = (a: number) => `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`
  const start = Math.PI
  const end = start + ratio * Math.PI
  const large = ratio > 0.5 ? 1 : 0
  const body =
    `<path d="M${point(start)} A${r},${r} 0 0 1 ${point(2 * Math.PI)}" fill="none" stroke="currentColor" opacity="0.15" stroke-width="26" stroke-linecap="round"/>` +
    (ratio > 0.001
      ? `<path d="M${point(start)} A${r},${r} 0 ${large} 1 ${point(end)}" fill="none" stroke="${escapeXml(color(spec, 0))}" stroke-width="26" stroke-linecap="round"/>`
      : "") +
    text(cx, cy - 30, `${fmt(value)}${spec.unit ?? ""}`, {
      anchor: "middle",
      size: 56,
      weight: 700,
    }) +
    text(cx, cy + 34, truncate(datum?.label ?? spec.title, 30), {
      anchor: "middle",
      size: 14,
      opacity: 0.7,
    })
  return svgWrap(spec, body, { ...opts, height: 340 })
}

// ---------------------------------------------------------------------------
// Metric — one headline value, remaining data as small multiples.
// ---------------------------------------------------------------------------

function metricSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const primary = spec.data[0]
  const rest = spec.data.slice(1, 5)
  let body = ""
  if (primary) {
    body +=
      text(WIDTH / 2, 190, `${fmt(primary.value)}${spec.unit ?? ""}`, {
        anchor: "middle",
        size: 104,
        weight: 700,
      }) +
      text(WIDTH / 2, 236, truncate(primary.label, 40), {
        anchor: "middle",
        size: 18,
        opacity: 0.75,
      })
    if (primary.group)
      body += text(WIDTH / 2, 262, truncate(primary.group, 40), {
        anchor: "middle",
        size: 13,
        opacity: 0.55,
      })
  }
  rest.forEach((d, i) => {
    const x = WIDTH / 2 + (i - (rest.length - 1) / 2) * 150
    body +=
      text(x, 330, `${fmt(d.value)}${spec.unit ?? ""}`, {
        anchor: "middle",
        size: 24,
        weight: 650,
      }) + text(x, 352, truncate(d.label, 16), { anchor: "middle", size: 12, opacity: 0.7 })
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Timeline / gantt — bars positioned on a parsed date axis.
// ---------------------------------------------------------------------------

function timelineSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const starts = spec.data.map((d) => Date.parse(d.start ?? ""))
  const ends = spec.data.map((d, i) => Date.parse(d.end ?? "") || starts[i])
  const validStarts = starts.filter(Number.isFinite)
  const validEnds = ends.filter(Number.isFinite)
  const lo = validStarts.length ? Math.min(...validStarts) : 0
  const hi = validEnds.length ? Math.max(...validEnds, lo + 1) : lo + 1
  const span = hi - lo || 1
  const px = (t: number) => PLOT_LEFT + ((t - lo) / span) * (PLOT_RIGHT - PLOT_LEFT)
  const n = Math.max(spec.data.length, 1)
  const rowH = Math.min(44, (HEIGHT - 64) / n)
  let body =
    `<line x1="${PLOT_LEFT}" y1="${HEIGHT - 30}" x2="${PLOT_RIGHT}" y2="${HEIGHT - 30}" stroke="currentColor" opacity="0.25"/>` +
    text(PLOT_LEFT, HEIGHT - 10, new Date(lo).toISOString().slice(0, 10), {
      size: 11,
      opacity: 0.7,
    }) +
    text(PLOT_RIGHT, HEIGHT - 10, new Date(hi).toISOString().slice(0, 10), {
      anchor: "end",
      size: 11,
      opacity: 0.7,
    })
  spec.data.forEach((d, i) => {
    const y = 28 + i * rowH
    const barH = Math.max(6, rowH * 0.58)
    const s = Number.isFinite(starts[i]) ? starts[i] : lo
    const e = Math.max(Number.isFinite(ends[i]) ? ends[i] : s, s)
    body +=
      `<rect x="${px(s)}" y="${y}" width="${Math.max(3, px(e) - px(s))}" height="${barH}" rx="${barH / 2}" fill="${escapeXml(color(spec, i))}"/>` +
      text(4, y + barH / 2 + 4, truncate(d.label, 16))
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Heatmap — group × label grid, cell opacity encodes value.
// ---------------------------------------------------------------------------

function heatmapSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const rows = [...new Set(spec.data.map((d) => d.group ?? ""))]
  const cols = [...new Set(spec.data.map((d) => d.label))]
  const max = Math.max(...spec.data.map((d) => Math.abs(d.value)), 1)
  const cellW = (PLOT_RIGHT - PLOT_LEFT) / Math.max(cols.length, 1)
  const cellH = (HEIGHT - 96) / Math.max(rows.length, 1)
  let body = ""
  spec.data.forEach((d) => {
    const cx = cols.indexOf(d.label)
    const cy = rows.indexOf(d.group ?? "")
    if (cx < 0 || cy < 0) return
    const x = PLOT_LEFT + cx * cellW
    const y = 40 + cy * cellH
    body +=
      `<rect x="${x + 2}" y="${y + 2}" width="${Math.max(2, cellW - 4)}" height="${Math.max(2, cellH - 4)}" rx="4" fill="${escapeXml(color(spec, 0))}" opacity="${Math.max(0.08, Math.abs(d.value) / max)}"/>` +
      (cellW > 52 && cellH > 20
        ? text(x + cellW / 2, y + cellH / 2 + 4, fmt(d.value), { anchor: "middle", size: 11 })
        : "")
  })
  cols.forEach((c, i) => {
    body += text(
      PLOT_LEFT + i * cellW + cellW / 2,
      30,
      truncate(c, Math.max(6, Math.floor(cellW / 8))),
      {
        anchor: "middle",
        size: 11,
        opacity: 0.75,
      }
    )
  })
  rows.forEach((r, i) => {
    if (r)
      body += text(4, 40 + i * cellH + cellH / 2 + 4, truncate(r, 14), { size: 11, opacity: 0.75 })
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Treemap — slice-and-dice layout proportional to value.
// ---------------------------------------------------------------------------

function treemapSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const total = spec.data.reduce((a, d) => a + Math.max(0, d.value), 0) || spec.data.length || 1
  let body = ""
  let x = 8
  let y = 32
  let w = WIDTH - 16
  let h = HEIGHT - 48
  let horizontal = true
  spec.data.forEach((d, i) => {
    const share = Math.max(0.02, Math.max(0, d.value) / total)
    const isLast = i === spec.data.length - 1
    const slice = isLast ? (horizontal ? w : h) : (horizontal ? w : h) * share
    const rw = horizontal ? slice : w
    const rh = horizontal ? h : slice
    body +=
      `<rect x="${x}" y="${y}" width="${Math.max(2, rw - 4)}" height="${Math.max(2, rh - 4)}" rx="6" fill="${escapeXml(color(spec, i))}" opacity="0.9"/>` +
      (rw > 88 && rh > 30
        ? text(x + 10, y + 22, truncate(d.label, Math.floor((rw - 20) / 7)), { weight: 600 }) +
          text(x + 10, y + 40, `${fmt(d.value)}${spec.unit ?? ""}`, { size: 11, opacity: 0.85 })
        : "")
    if (horizontal) {
      x += slice
      w -= slice
    } else {
      y += slice
      h -= slice
    }
    horizontal = !horizontal
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Box — quartiles per group (or per label when no groups exist).
// ---------------------------------------------------------------------------

function quartile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return (
    sorted[base] + (sorted[base + 1] !== undefined ? rest * (sorted[base + 1] - sorted[base]) : 0)
  )
}

function boxSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const groups = new Map<string, number[]>()
  for (const d of spec.data) {
    const key = d.group ?? d.label
    const list = groups.get(key) ?? []
    if (Number.isFinite(d.value)) list.push(d.value)
    groups.set(key, list)
  }
  const keys = [...groups.keys()]
  const all = [...groups.values()].flat()
  const { lo, hi } = extent(all)
  const span = hi - lo || 1
  const py = (v: number) => HEIGHT - 56 - ((v - lo) / span) * (HEIGHT - 120)
  const colW = (PLOT_RIGHT - PLOT_LEFT) / Math.max(keys.length, 1)
  let body = ""
  keys.forEach((key, i) => {
    const values = (groups.get(key) ?? []).sort((a, b) => a - b)
    if (!values.length) return
    const cx = PLOT_LEFT + i * colW + colW / 2
    const bw = Math.min(64, colW * 0.5)
    const q1 = quartile(values, 0.25)
    const med = quartile(values, 0.5)
    const q3 = quartile(values, 0.75)
    const min = values[0]
    const maxV = values[values.length - 1]
    body +=
      `<line x1="${cx}" y1="${py(maxV)}" x2="${cx}" y2="${py(min)}" stroke="${escapeXml(color(spec, i))}" stroke-width="2"/>` +
      `<line x1="${cx - bw / 4}" y1="${py(maxV)}" x2="${cx + bw / 4}" y2="${py(maxV)}" stroke="${escapeXml(color(spec, i))}" stroke-width="2"/>` +
      `<line x1="${cx - bw / 4}" y1="${py(min)}" x2="${cx + bw / 4}" y2="${py(min)}" stroke="${escapeXml(color(spec, i))}" stroke-width="2"/>` +
      `<rect x="${cx - bw / 2}" y="${py(q3)}" width="${bw}" height="${Math.max(2, py(q1) - py(q3))}" fill="${escapeXml(color(spec, i))}" opacity="0.35" stroke="${escapeXml(color(spec, i))}"/>` +
      `<line x1="${cx - bw / 2}" y1="${py(med)}" x2="${cx + bw / 2}" y2="${py(med)}" stroke="${escapeXml(color(spec, i))}" stroke-width="3"/>` +
      text(cx, HEIGHT - 30, truncate(key, 14), { anchor: "middle", size: 11 })
  })
  return svgWrap(spec, body, opts)
}

// ---------------------------------------------------------------------------
// Graph (network / sankey / process) — layered node-link diagram.
// ---------------------------------------------------------------------------

function graphSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  const order: string[] = []
  const layerOf = new Map<string, number>()
  const isSource = new Set<string>()
  const isTarget = new Set<string>()
  for (const d of spec.data) {
    if (d.source) isSource.add(d.source)
    if (d.target) isTarget.add(d.target)
  }
  for (const d of spec.data) {
    for (const node of [d.source, d.target]) {
      if (!node || layerOf.has(node)) continue
      const layer = isSource.has(node) && isTarget.has(node) ? 1 : isSource.has(node) ? 0 : 2
      layerOf.set(node, layer)
      order.push(node)
    }
  }
  const layers: string[][] = [[], [], []]
  for (const node of order) layers[layerOf.get(node) ?? 1].push(node)
  if (!layers[0].length && !layers[2].length && layers[1].length)
    layers[1].forEach((_, i) => (i % 2 === 0 ? layers[0] : layers[2]).push(layers[1][i]))
  const pos = new Map<string, { x: number; y: number }>()
  const colX = [120, 360, 600]
  layers.forEach((nodes, layer) => {
    nodes.forEach((node, i) => {
      pos.set(node, {
        x: colX[layer],
        y: 60 + i * ((HEIGHT - 120) / Math.max(nodes.length - 1, 1)),
      })
    })
  })
  const max = Math.max(...spec.data.map((d) => Math.abs(d.value)), 1)
  let body = ""
  for (const d of spec.data) {
    const a = d.source ? pos.get(d.source) : undefined
    const b = d.target ? pos.get(d.target) : undefined
    if (!a || !b) continue
    const width = 1.5 + (Math.abs(d.value) / max) * (spec.profile === "sankey" ? 10 : 4)
    body += `<path d="M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}" fill="none" stroke="${escapeXml(color(spec, 0))}" stroke-width="${width}" opacity="0.55"><title>${escapeXml(`${d.source} → ${d.target}: ${fmt(d.value)}${spec.unit ?? ""}`)}</title></path>`
  }
  for (const [node, p] of pos) {
    body +=
      `<circle cx="${p.x}" cy="${p.y}" r="9" fill="${escapeXml(color(spec, layerOf.get(node) ?? 0))}"/>` +
      text(p.x + 14, p.y + 4, truncate(node, 18), { size: 12, weight: 600 })
  }
  return svgWrap(spec, body, opts)
}

/** Data-table columns, emitted only when some datum actually carries them. */
export const VISUALIZATION_COLUMNS = [
  "label",
  "value",
  "group",
  "source",
  "target",
  "start",
  "end",
  "x",
  "y",
] as const
export type VisualizationColumn = (typeof VISUALIZATION_COLUMNS)[number]

export function visualizationColumns(spec: VisualizationSpec): VisualizationColumn[] {
  return VISUALIZATION_COLUMNS.filter(
    (key) =>
      key === "label" ||
      key === "value" ||
      spec.data.some((datum) => datum[key] !== undefined && datum[key] !== "")
  )
}

// ---------------------------------------------------------------------------
// Table profile — text rows for standalone SVG export (the preview renders a
// real <table> element instead).
// ---------------------------------------------------------------------------

function tableSvg(spec: VisualizationSpec, opts: { standalone?: boolean }): string {
  let body = ""
  spec.data.slice(0, 20).forEach((d, i) => {
    const y = 44 + i * 18
    if (i % 2 === 0)
      body += `<rect x="4" y="${y - 13}" width="${WIDTH - 8}" height="18" fill="currentColor" opacity="0.04"/>`
    body +=
      text(12, y, truncate(d.label, 40)) +
      text(WIDTH - 12, y, `${fmt(d.value)}${spec.unit ?? ""}`, { anchor: "end", weight: 600 })
  })
  return svgWrap(spec, body, { ...opts, height: 60 + spec.data.slice(0, 20).length * 18 })
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function buildChartSvg(
  spec: VisualizationSpec,
  opts: { standalone?: boolean } = {}
): string {
  switch (spec.profile) {
    case "line":
    case "simulation":
      return lineSvg(spec, false, opts)
    case "area":
      return lineSvg(spec, true, opts)
    case "scatter":
    case "map":
      return scatterSvg(spec, opts)
    case "pie":
      return pieSvg(spec, false, opts)
    case "donut":
      return pieSvg(spec, true, opts)
    case "radar":
      return radarSvg(spec, opts)
    case "gauge":
      return gaugeSvg(spec, opts)
    case "metric":
      return metricSvg(spec, opts)
    case "timeline":
    case "gantt":
      return timelineSvg(spec, opts)
    case "heatmap":
      return heatmapSvg(spec, opts)
    case "treemap":
      return treemapSvg(spec, opts)
    case "box":
      return boxSvg(spec, opts)
    case "network":
    case "sankey":
    case "process":
      return graphSvg(spec, opts)
    case "funnel":
      return funnelSvg(spec, opts)
    case "table":
      return tableSvg(spec, opts)
    case "bar":
    case "histogram":
    default:
      return barsSvg(spec, opts)
  }
}
