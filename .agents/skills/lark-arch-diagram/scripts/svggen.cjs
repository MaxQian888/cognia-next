/*
 * Styled architecture-diagram SVG generator for Lark whiteboard.
 * Data-driven: reads a spec JSON (absolute coords), emits a self-contained SVG
 * in the "titled header + legend + tinted group containers + boxed nodes +
 * orthogonal connectors" aesthetic.
 *
 * Constraints (Lark whiteboard svg-parser): only rect/circle/ellipse/polygon,
 * line/polyline/path, text/tspan, g/use, translate/rotate/scale. NO
 * radialGradient/filter/pattern/clipPath/mask/marker. Arrowheads are drawn as
 * explicit <polygon> triangles.
 *
 * Usage: node svggen.cjs spec.json out.svg
 */
const fs = require('fs');

const PALETTE = {
  blue:   { s: '#3b82f6', f: '#eff6ff', g: '#eff6ff' },
  green:  { s: '#10b981', f: '#ecfdf5', g: '#ecfdf5' },
  orange: { s: '#f97316', f: '#fff7ed', g: '#fff7ed' },
  purple: { s: '#8b5cf6', f: '#f5f3ff', g: '#f5f3ff' },
  cyan:   { s: '#0891b2', f: '#ecfeff', g: '#ecfeff' },
  slate:  { s: '#64748b', f: '#f8fafc', g: '#f1f5f9' },
  red:    { s: '#ef4444', f: '#fef2f2', g: '#fef2f2' },
  amber:  { s: '#d97706', f: '#fffbeb', g: '#fffbeb' },
  teal:   { s: '#14b8a6', f: '#f0fdfa', g: '#f0fdfa' },
  indigo: { s: '#6366f1', f: '#eef2ff', g: '#eef2ff' },
  rose:   { s: '#e11d48', f: '#fff1f2', g: '#fff1f2' },
};
const INK = '#1f2937';
const SUBINK = '#64748b';
const LINE = '#94a3b8';
const FONT = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pal = (c) => PALETTE[c] || PALETTE.slate;

function textLines(cx, yTop, lines) {
  // lines: [{t, size, weight, color, lh}]
  let out = '';
  let y = yTop;
  for (const l of lines) {
    y += l.size; // advance to baseline
    out += `<text x="${cx}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${l.size}" font-weight="${l.weight}" fill="${l.color}" text-anchor="middle">${esc(l.t)}</text>\n`;
    y += (l.lh - l.size);
  }
  return out;
}

function nodeSvg(n) {
  const c = pal(n.color);
  const rx = n.rx != null ? n.rx : 12;
  const shape = n.shape || 'rect';
  let box;
  if (shape === 'cyl') {
    // database cylinder from paths + ellipses
    const { x, y, w, h } = n;
    const ry = Math.min(14, h * 0.14);
    box =
      `<path d="M${x} ${y + ry} A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L${x + w} ${y + h - ry} A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z" fill="${n.fill || c.f}" stroke="${c.s}" stroke-width="2"/>` +
      `<ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${n.fill || c.f}" stroke="${c.s}" stroke-width="2"/>`;
  } else {
    box = `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${n.fill || c.f}" stroke="${c.s}" stroke-width="2"/>`;
  }
  const titleLines = String(n.title).split('\n');
  const subLines = n.sub ? String(n.sub).split('\n') : [];
  const tSize = n.tsize || 15.5, tLH = tSize + 5;
  const sSize = n.ssize || 12.5, sLH = sSize + 4;
  const gap = subLines.length ? 4 : 0;
  const total = titleLines.length * tLH + gap + subLines.length * sLH;
  const cx = n.x + n.w / 2;
  const yTop = n.y + (n.h - total) / 2 + (shape === 'cyl' ? 4 : 0);
  const lines = [];
  for (const t of titleLines) lines.push({ t, size: tSize, weight: 700, color: n.tcolor || INK, lh: tLH });
  const subGap = subLines.length ? gap : 0;
  let txt = textLines(cx, yTop, lines);
  if (subLines.length) {
    const subTop = yTop + titleLines.length * tLH + subGap;
    txt += textLines(cx, subTop, subLines.map((t) => ({ t, size: sSize, weight: 400, color: n.scolor || SUBINK, lh: sLH })));
  }
  return box + '\n' + txt;
}

function groupSvg(gp) {
  const c = pal(gp.color);
  const rx = gp.rx != null ? gp.rx : 16;
  let s = `<rect x="${gp.x}" y="${gp.y}" width="${gp.w}" height="${gp.h}" rx="${rx}" fill="${gp.fill || c.g}" stroke="${c.s}" stroke-width="1.2" stroke-opacity="0.35"/>`;
  if (gp.title) {
    s += `\n<text x="${gp.x + 20}" y="${gp.y + 27}" font-family="${FONT}" font-size="15" font-weight="700" fill="${c.s}">${esc(gp.title)}</text>`;
  }
  return s;
}

function anchor(n, side, t = 0.5) {
  if (side === 'right') return [n.x + n.w, n.y + n.h * t];
  if (side === 'left') return [n.x, n.y + n.h * t];
  if (side === 'top') return [n.x + n.w * t, n.y];
  return [n.x + n.w * t, n.y + n.h]; // bottom
}

function pickSides(a, b) {
  const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
  const dx = bc[0] - ac[0], dy = bc[1] - ac[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function routePoints(p0, s0, p1, s1) {
  // orthogonal route; S-shape via midpoint on the dominant axis
  const horiz = (s0 === 'left' || s0 === 'right');
  if (horiz && (s1 === 'left' || s1 === 'right')) {
    const mx = (p0[0] + p1[0]) / 2;
    return [p0, [mx, p0[1]], [mx, p1[1]], p1];
  }
  if (!horiz && (s1 === 'top' || s1 === 'bottom')) {
    const my = (p0[1] + p1[1]) / 2;
    return [p0, [p0[0], my], [p1[0], my], p1];
  }
  // mixed: L-shape (H then V or V then H)
  if (horiz) return [p0, [p1[0], p0[1]], p1];
  return [p0, [p0[0], p1[1]], p1];
}

function arrowHead(pen, tip) {
  // triangle at tip pointing from pen->tip
  const dx = tip[0] - pen[0], dy = tip[1] - pen[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sz = 8, wd = 4.6;
  const bx = tip[0] - ux * sz, by = tip[1] - uy * sz;
  const p1 = [bx - uy * wd, by + ux * wd];
  const p2 = [bx + uy * wd, by - ux * wd];
  return { poly: `${tip[0].toFixed(1)},${tip[1].toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`, base: [bx, by] };
}

function edgeSvg(e, byId) {
  const a = byId[e.from], b = byId[e.to];
  if (!a || !b) return '';
  let [s0, s1] = pickSides(a, b);
  if (e.fromSide) s0 = e.fromSide;
  if (e.toSide) s1 = e.toSide;
  const p0 = anchor(a, s0, e.fromT != null ? e.fromT : 0.5);
  let p1 = anchor(b, s1, e.toT != null ? e.toT : 0.5);
  let pts = e.waypoints ? [p0, ...e.waypoints, p1] : routePoints(p0, s0, p1, s1);
  const col = e.color ? pal(e.color).s : LINE;
  const w = e.width || 2;
  const dash = e.dash ? ` stroke-dasharray="${e.dash === true ? '5 5' : e.dash}"` : '';
  // shorten last segment for arrowhead
  const pen = pts[pts.length - 2], tip = pts[pts.length - 1];
  const ah = arrowHead(pen, tip);
  const drawPts = pts.slice(0, -1).concat([ah.base]);
  const poly = drawPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  let s = `<polyline points="${poly}" fill="none" stroke="${col}" stroke-width="${w}"${dash} stroke-linejoin="round" stroke-linecap="round"/>`;
  s += `\n<polygon points="${ah.poly}" fill="${col}"/>`;
  if (e.label) {
    // label near the mid elbow
    const mid = pts[Math.floor(pts.length / 2)] || pts[1];
    const lx = e.lx != null ? e.lx : mid[0];
    const ly = e.ly != null ? e.ly : mid[1] - 8;
    const lines = String(e.label).split('\n');
    const lw = Math.max(...lines.map((t) => t.length)) * 6.6 + 12;
    const lh = lines.length * 15 + 6;
    s += `\n<rect x="${(lx - lw / 2).toFixed(1)}" y="${(ly - 12).toFixed(1)}" width="${lw.toFixed(1)}" height="${lh}" rx="5" fill="#ffffff" fill-opacity="0.92"/>`;
    let ty = ly - 12;
    for (const t of lines) { ty += 13; s += `\n<text x="${lx.toFixed(1)}" y="${ty.toFixed(1)}" font-family="${FONT}" font-size="12" fill="${e.lcolor ? pal(e.lcolor).s : '#475569'}" text-anchor="middle">${esc(t)}</text>`; }
  }
  return s;
}

function legendSvg(lg, W) {
  if (!lg || !lg.items) return '';
  const rowH = 26, padT = 14, padB = 12, titleH = lg.title ? 24 : 0;
  const w = lg.w || 240;
  const h = padT + titleH + lg.items.length * rowH + padB - 8;
  const x = lg.x != null ? lg.x : W - w - 40;
  const y = lg.y != null ? lg.y : 40;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>`;
  let cy = y + padT;
  if (lg.title) { cy += 16; s += `\n<text x="${x + 18}" y="${cy}" font-family="${FONT}" font-size="13" font-weight="700" fill="#334155">${esc(lg.title)}</text>`; cy += 12; }
  for (const it of lg.items) {
    const c = pal(it.color);
    const sy = cy + 4;
    s += `\n<rect x="${x + 18}" y="${sy}" width="16" height="16" rx="4" fill="${c.f}" stroke="${c.s}" stroke-width="1.6"/>`;
    s += `\n<text x="${x + 42}" y="${sy + 13}" font-family="${FONT}" font-size="13" fill="#334155">${esc(it.label)}</text>`;
    cy += rowH;
  }
  return s;
}

function cardSvg(cd) {
  const c = pal(cd.color);
  const headH = 40, itemH = 32, gap = 8, padB = 16, padX = 14;
  const items = cd.items || [];
  const h = cd.h != null ? cd.h : headH + items.length * itemH + (items.length - 1) * gap + padB;
  let s = `<rect x="${cd.x}" y="${cd.y}" width="${cd.w}" height="${h}" rx="14" fill="${cd.fill || c.g}" stroke="${c.s}" stroke-width="1.4" stroke-opacity="0.45"/>`;
  s += `\n<rect x="${cd.x}" y="${cd.y + 12}" width="5" height="20" rx="2.5" fill="${c.s}"/>`;
  s += `\n<text x="${cd.x + 16}" y="${cd.y + 28}" font-family="${FONT}" font-size="16" font-weight="700" fill="${c.s}">${esc(cd.title)}</text>`;
  let iy = cd.y + headH;
  for (const it of items) {
    s += `\n<rect x="${cd.x + padX}" y="${iy}" width="${cd.w - 2 * padX}" height="${itemH}" rx="8" fill="#ffffff" stroke="#e5e9f0" stroke-width="1"/>`;
    s += `\n<text x="${cd.x + cd.w / 2}" y="${iy + itemH / 2 + 4.5}" font-family="${FONT}" font-size="12.8" fill="#334155" text-anchor="middle">${esc(it)}</text>`;
    iy += itemH + gap;
  }
  return s;
}

function headerSvg(spec) {
  const px = spec.headerX || 40, py = spec.headerY || 34;
  const accent = spec.accent ? pal(spec.accent).s : '#14b8a6';
  let s = `<rect x="${px}" y="${py}" width="6" height="30" rx="3" fill="${accent}"/>`;
  s += `\n<text x="${px + 18}" y="${py + 24}" font-family="${FONT}" font-size="25" font-weight="700" fill="#1f2d3d">${esc(spec.title)}</text>`;
  if (spec.subtitle) s += `\n<text x="${px + 18}" y="${py + 50}" font-family="${FONT}" font-size="14.5" fill="#64748b">${esc(spec.subtitle)}</text>`;
  return s;
}

function build(spec) {
  const W = spec.w, H = spec.h;
  const byId = {};
  for (const n of spec.nodes || []) byId[n.id] = n;
  let body = '';
  body += `<rect x="0" y="0" width="${W}" height="${H}" fill="${spec.bg || '#ffffff'}"/>\n`;
  for (const gp of spec.groups || []) body += groupSvg(gp) + '\n';
  for (const cd of spec.cards || []) body += cardSvg(cd) + '\n';
  for (const e of spec.edges || []) body += edgeSvg(e, byId) + '\n';
  for (const n of spec.nodes || []) body += nodeSvg(n) + '\n';
  body += headerSvg(spec) + '\n';
  body += legendSvg(spec.legend, W) + '\n';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n${body}</svg>\n`;
}

const [, , specPath, outPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
fs.writeFileSync(outPath, build(spec));
console.log('wrote', outPath, spec.nodes ? spec.nodes.length + ' nodes' : '', spec.edges ? spec.edges.length + ' edges' : '');
