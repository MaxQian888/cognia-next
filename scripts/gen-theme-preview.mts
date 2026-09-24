// Temporary preview generator: renders a mini-app mock per built-in theme and
// variant using the resolved 56-token palette (same normalizeThemeColors pass
// the app runs), so what we screenshot is what the app would paint.
import { writeFileSync, mkdirSync } from "node:fs"
import { BUILT_IN_DESIGNED_THEMES } from "../lib/themes/built-in-themes"
import { BUILT_IN_VSCODE_THEMES } from "../lib/appearance/built-in-vscode-themes"
import { normalizeThemeColors, THEME_TOKEN_CATALOG } from "../lib/appearance/theme-token-catalog"
import type { ThemeColors } from "../types/plugin/plugin"

interface Entry {
  name: string
  variant: "light" | "dark"
  colors: ThemeColors
}

const entries: Entry[] = []
for (const t of BUILT_IN_DESIGNED_THEMES) {
  for (const v of ["light", "dark"] as const) {
    entries.push({ name: t.name, variant: v, colors: normalizeThemeColors(t.tokens![v], v) })
  }
}
for (const t of BUILT_IN_VSCODE_THEMES) {
  for (const v of ["light", "dark"] as const) {
    entries.push({ name: t.name, variant: v, colors: normalizeThemeColors(t.tokens![v], v) })
  }
}

function varsFor(c: ThemeColors): string {
  return THEME_TOKEN_CATALOG.map((d) => {
    const v = (c as Record<string, string | undefined>)[d.key]
    return v ? `${d.cssVar}:${v};` : ""
  }).join("")
}

const card = (e: Entry) => `
<div class="frame" data-theme="${e.name}-${e.variant}" style="${varsFor(e.colors)}">
  <div class="titlebar"><span class="tname">${e.name}</span><span class="tvar">${e.variant}</span></div>
  <div class="app">
    <aside class="rail">
      <div class="rail-logo"></div>
      <div class="rail-item active"><span class="dot"></span>Chat</div>
      <div class="rail-item"><span class="dot"></span>Agents</div>
      <div class="rail-item"><span class="dot"></span>Workflow</div>
      <div class="rail-item"><span class="dot"></span>Settings</div>
      <div class="rail-foot">12 running</div>
    </aside>
    <main>
      <header class="topbar">
        <div>
          <div class="h1">Weekly report agent</div>
          <div class="hsub">Last edited 2h ago · autosaved</div>
        </div>
        <button class="btn ghost">Share</button>
        <button class="btn outline">Duplicate</button>
        <button class="btn primary">Run</button>
      </header>

      <section class="card">
        <div class="card-h">Configuration</div>
        <div class="card-sub">Tune the schedule and the channels this agent posts to.</div>
        <div class="row">
          <label class="lab">Name</label>
          <div class="input">Weekly digest — every Friday 9:00</div>
        </div>
        <div class="row btns">
          <button class="btn secondary">Secondary</button>
          <button class="btn ghost">Ghost</button>
          <button class="btn destructive">Delete</button>
        </div>
      </section>

      <section class="cols">
        <div class="card">
          <div class="card-h">Menu (hover = accent)</div>
          <div class="menu">
            <div class="mi">Rename…</div>
            <div class="mi hover">Duplicate</div>
            <div class="mi">Export</div>
            <div class="mi danger">Delete</div>
          </div>
        </div>
        <div class="card">
          <div class="card-h">Status & signals</div>
          <div class="chips">
            <span class="chip"><i class="d" style="background:var(--success)"></i>Running</span>
            <span class="chip"><i class="d" style="background:var(--warning)"></i>Queued</span>
            <span class="chip"><i class="d" style="background:var(--info)"></i>Info</span>
            <span class="chip"><i class="d" style="background:var(--destructive)"></i>Failed</span>
          </div>
          <div class="chips">
            <span class="sw" style="background:var(--chart-1)"></span>
            <span class="sw" style="background:var(--chart-2)"></span>
            <span class="sw" style="background:var(--chart-3)"></span>
            <span class="sw" style="background:var(--chart-4)"></span>
            <span class="sw" style="background:var(--chart-5)"></span>
            <span class="swlbl">charts</span>
          </div>
          <div class="chips">
            <span class="sw" style="background:var(--wf-trigger)"></span>
            <span class="sw" style="background:var(--wf-action)"></span>
            <span class="sw" style="background:var(--wf-ai)"></span>
            <span class="sw" style="background:var(--wf-flow)"></span>
            <span class="sw" style="background:var(--wf-data)"></span>
            <span class="sw" style="background:var(--wf-io)"></span>
            <span class="sw" style="background:var(--wf-annotation)"></span>
            <span class="swlbl">workflow</span>
          </div>
          <div class="chips">
            <span class="effort">Ultra</span>
            <span class="chip"><i class="d" style="background:var(--brand-action)"></i>action</span>
            <span class="chip"><i class="d" style="background:var(--brand-approval)"></i>approval</span>
          </div>
        </div>
      </section>

      <section class="card muted-block">
        <span class="mut">Muted block · muted-foreground text sample — 12 items archived</span>
        <button class="btn secondary sm">Restore</button>
      </section>
    </main>
  </div>
</div>`

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", sans-serif; margin: 0 }
  body { background: #888; display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; padding: 24px }
  .frame { background: var(--background); color: var(--foreground); border-radius: 10px; overflow: hidden; border: 1px solid var(--border) }
  .titlebar { display: flex; justify-content: space-between; padding: 8px 12px; font: 600 12px/1 monospace; background: #0008; color: #fff }
  .app { display: flex; min-height: 460px }
  .rail { width: 128px; background: var(--sidebar); color: var(--sidebar-foreground); border-right: 1px solid var(--sidebar-border); padding: 10px 8px; display: flex; flex-direction: column; gap: 2px }
  .rail-logo { width: 20px; height: 20px; border-radius: 6px; background: var(--sidebar-primary); margin: 2px 6px 10px }
  .rail-item { font-size: 11px; padding: 6px 8px; border-radius: 6px; display: flex; gap: 6px; align-items: center; color: var(--sidebar-foreground) }
  .rail-item .dot { width: 6px; height: 6px; border-radius: 3px; background: var(--sidebar-ring) }
  .rail-item.active { background: var(--sidebar-accent); color: var(--sidebar-accent-foreground) }
  .rail-item:not(.active):hover { background: var(--sidebar-accent) }
  .rail-foot { margin-top: auto; font-size: 10px; color: var(--muted-foreground); padding: 4px 8px }
  main { flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 12px; background: var(--background) }
  .topbar { display: flex; align-items: center; gap: 8px }
  .topbar > div { margin-right: auto }
  .h1 { font-size: 14px; font-weight: 600; color: var(--foreground) }
  .hsub { font-size: 11px; color: var(--muted-foreground); margin-top: 2px }
  .btn { font-size: 11px; font-weight: 500; border-radius: 6px; padding: 6px 12px; border: 1px solid transparent; cursor: default; background: transparent; color: inherit }
  .btn.sm { padding: 3px 9px; font-size: 10px }
  .btn.primary { background: var(--primary); color: var(--primary-foreground) }
  .btn.secondary { background: var(--secondary); color: var(--secondary-foreground) }
  .btn.outline { border-color: var(--input); background: var(--background); color: var(--foreground) }
  .btn.ghost { color: var(--foreground) }
  .btn.ghost:hover { background: var(--accent); color: var(--accent-foreground) }
  .btn.destructive { background: var(--destructive); color: var(--destructive-foreground) }
  .card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 8px; padding: 12px }
  .card-h { font-size: 12px; font-weight: 600 }
  .card-sub { font-size: 11px; color: var(--muted-foreground); margin: 2px 0 10px }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 8px }
  .lab { font-size: 11px; color: var(--muted-foreground); width: 40px }
  .input { flex: 1; font-size: 11px; padding: 6px 8px; border: 1px solid var(--input); border-radius: 6px; color: var(--foreground); background: var(--background) }
  .row.btns { gap: 6px }
  .cols { display: grid; grid-template-columns: 1fr 1.4fr; gap: 12px }
  .menu { background: var(--popover); color: var(--popover-foreground); border: 1px solid var(--border); border-radius: 8px; padding: 4px; margin-top: 8px }
  .mi { font-size: 11px; padding: 6px 8px; border-radius: 5px }
  .mi.hover { background: var(--accent); color: var(--accent-foreground) }
  .mi.danger { color: var(--destructive) }
  .chips { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap }
  .chip { font-size: 10px; display: flex; gap: 5px; align-items: center; color: var(--foreground) }
  .chip .d { width: 8px; height: 8px; border-radius: 4px }
  .sw { width: 12px; height: 12px; border-radius: 4px }
  .swlbl { font-size: 9px; color: var(--muted-foreground) }
  .effort { font-size: 10px; font-weight: 600; color: var(--effort-ultra); border: 1px solid var(--effort-ultra); background: var(--effort-ultra-muted); padding: 2px 8px; border-radius: 999px }
  .muted-block { background: var(--muted); display: flex; justify-content: space-between; align-items: center }
  .mut { font-size: 11px; color: var(--muted-foreground) }
</style>
<body>
${entries.map(card).join("\n")}
</body>`

mkdirSync("preview-out", { recursive: true })
writeFileSync("preview-out/themes.html", html)
console.log(`wrote preview-out/themes.html with ${entries.length} frames`)
