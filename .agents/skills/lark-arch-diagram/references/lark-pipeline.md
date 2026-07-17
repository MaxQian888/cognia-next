# Feishu / Lark insertion pipeline + traps

How to land the generated SVGs into Feishu and verify them, plus every trap hit
building this. All `lark-cli` calls use `--as user` (see `lark-shared` for auth).

## Insert SVGs into a new Feishu doc

Reference each SVG by **`path="@file.svg"`**, never inline the SVG. `path` makes the
CLI read the raw file and embed it, so you avoid XML-escaping the SVG's `<`, `>`, and
`<br/>`. The `@` path is resolved relative to the **current working directory**, so
run from the dir holding the `.svg` files.

Build a `doc.xml` — a title, and per diagram a heading + one short prose paragraph +
a whiteboard block:

```xml
<title>项目 架构图集</title>
<p>一句话说明这份图集是什么。</p>
<h2>1 · 系统总览</h2>
<p>这张图讲什么，一两句。</p>
<whiteboard type="svg" path="@1-overview.svg"></whiteboard>
<h2>2 · 运行时拓扑</h2>
<p>……</p>
<whiteboard type="svg" path="@2-topology.svg"></whiteboard>
```

Keep prose clean of `<`, `>`, `&` (use `→` not `>`); those are the only chars needing
escaping in `<p>` text. Then create from the SVG dir:

```bash
rtk lark-cli docs +create --content "$(rtk cat doc.xml)" --as user --json
```

Passing `--content "$(cat doc.xml)"` keeps the shell arg clean: command-substitution
output isn't re-tokenized, so inner `"` and `<>` are literal data. Don't try
`--content @doc.xml` — `--content` doesn't reliably accept `@file` and may take the
literal string as the body.

**Response** (`data.document`):
- `url` — the doc link to give the user.
- `new_blocks[]` — one entry per created whiteboard, each with `block_token`.

**Verify the count.** If `new_blocks` has fewer entries than diagrams, or the
response carries `warnings: [degrade_code=2107, Whiteboard content parse failed]`,
one diagram failed to parse and was silently dropped. Fetch the doc
(`docs +fetch --detail with-ids`) to see which heading has no `<whiteboard>` after
it, fix that SVG, and recreate.

## Insert into an existing doc / whiteboard

- **Existing doc**: same `<whiteboard type="svg" path="@x.svg">` via
  `docs +update --command block_insert_after --block-id <anchor>` (see `lark-doc`).
- **Existing standalone whiteboard**: `lark-cli whiteboard +update` accepts DSL,
  mermaid, or SVG. For the DSL mindmap route and its `--overwrite` ordering rules,
  see the `lark-whiteboard` / `lark-whiteboard-mindmap` skills.

## Verify the Feishu render (do this every time)

Feishu re-parses the SVG server-side; its parser is stricter than the local
whiteboard-cli, so **always** export a thumbnail and look at it:

```bash
rtk lark-cli whiteboard +query --whiteboard-token <block_token> \
  --output_as image --output fb-1.png --as user
```

- Exports use a fixed **2560×2560** canvas, so the diagram sits in a corner with lots
  of whitespace → PNG files are small (1–8 KB). That's normal, not a failure; the
  content is faithful.
- A **0 KB** output is a transient fetch failure — re-run that single export.
- Read every `fb-*.png` and confirm each diagram rendered before reporting done.

Alternatively `lark-cli docs +media-download --type whiteboard` fetches a board
thumbnail.

## The mermaid quick-route (plainer, sometimes fine)

For a throwaway or when auto-layout is acceptable, skip the generator and inline
mermaid: `<whiteboard type="mermaid" path="@flow.mmd">`. Feishu supports flowchart,
mindmap (思维导图), sequence (时序图), class, pie, gantt. It's fast but you don't
control spacing/color/grouping — it always looks generic. Preview with
`whiteboard-cli -i flow.mmd -o flow.png`.

## Traps (each cost a real failure)

1. **Mermaid `sequenceDiagram` + `<br/>` → parse failure.** The CLI converts `<br/>`
   in mermaid to a real newline. In a sequenceDiagram, `participant X as a<br/>b` or
   `Note over A,B: x<br/>y` then spans two lines and breaks the one-statement-per-line
   grammar; the whole board silently drops. Keep sequence participant aliases and
   notes single-line (no `<br/>`). Better: for a request lifecycle, use this skill's
   SVG route (numbered boxes + a loop group) instead of a mermaid sequence.

2. **SVG parser feature limits.** Feishu's whiteboard SVG parser supports
   rect/circle/ellipse/polygon, line/polyline/path, text/tspan, g/use, and
   translate/rotate/scale. It does **not** support `marker`, `filter`,
   `radialGradient`, `clipPath`, `mask`, `pattern`. `svggen.cjs` already respects
   this — arrowheads are explicit `<polygon>` triangles, cylinders are
   `path`+`ellipse`. If you hand-edit SVG, stay inside these primitives.

3. **`path="@file"` beats inline.** Inline SVG/mermaid inside `<whiteboard>` collides
   with the doc's own XML parser (`<br/>`, `-->`, `<` all ambiguous). The file-path
   form sidesteps all of it.

4. **Run from the SVG dir.** `@name.svg` resolves against CWD. `lark-cli` rejects
   absolute `@/…` paths as unsafe, so `cd` into the work dir first.

5. **Edge-label overlap on tight pipelines.** Label chips are wider than a 50px gap.
   Space chained boxes ≥ ~70px or use circled-number labels. (See spec-schema.)

6. **Deleting a doc needs scope.** `drive +delete --file-token <t> --type docx --yes`
   requires the `space:document:delete` scope; a user token often lacks it and returns
   `missing_scope`. Don't push an auth flow for cleanup — tell the user to delete in
   Feishu (recoverable trash), or to grant the scope via
   `lark-cli auth login --scope "space:document:delete"` if they want you to.

7. **Creating/overwriting a Feishu doc is outward-facing.** Preview PNGs locally and
   get the design right first; only then create. When replacing a prior draft, confirm
   before deleting it.
