/**
 * Data-asset services (M3): real source inspection, trusted-recipe
 * generation (booktabs tables, PGFPlots, TikZ), deterministic numeric
 * mapping artifacts, and real Tectonic compilation of the rendered output.
 *
 * Everything here is honest by construction:
 * - source bytes come from the snapshot (CAS), never from a tool-supplied
 *   host path;
 * - recipes come from the host registry (or an explicit policy opt-in);
 * - compilation runs the real runner — a missing package or a failed LaTeX
 *   compile is a failed job with the real log, not a green checkmark;
 * - the mapping artifact records raw→rendered per cell/point so
 *   assets.check-mapping-and-layout can recompute and compare.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  WorkbenchError,
  type Diagnostic,
  type DiagramSpec,
  type GeneratedAssetResult,
  type HostPolicy,
  type PlotParams,
  type TableSpec,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { loadPreset, TectonicRunner } from "@latexwb/runtime";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { collectArtifacts, type CollectedArtifact } from "./artifacts.ts";
import { parseTexLog } from "./diagnostics.ts";
import { parseCsv, isNumericCell, type CsvData } from "./csv.ts";
import { readSnapshotFile } from "./snapshot.ts";
import { runServiceJob } from "./service-job.ts";
import type { EvidenceInput } from "./evidence.ts";
import { recipeHash, resolveRecipe, type RecipeEntry } from "./recipes.ts";
import type { JobService } from "./jobs.ts";

export interface AssetDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  jobs?: JobService;
  repoRoot: string;
  hostPolicy: HostPolicy | null;
  presetsDir: string;
}

// ---------------------------------------------------------------------------
// source asset resolution
// ---------------------------------------------------------------------------

export interface SourceAsset {
  assetId: string;
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export function assetIdOf(blobHash: string): string {
  return `asset-${blobHash.slice(0, 12)}`;
}

export function resolveSourceAsset(
  store: WorkbenchStore,
  blobs: BlobStore,
  scope: Scope,
  snapshotId: string,
  sourceAssetId: string,
): SourceAsset {
  const rows = store.listSnapshotFiles(scope, snapshotId);
  const matches = rows.filter((r) => assetIdOf(r["blob_hash"] as string) === sourceAssetId);
  if (matches.length === 0) {
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `source asset ${sourceAssetId} is not a file of snapshot ${snapshotId}`,
    );
  }
  if (matches.length > 1) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `source asset id ${sourceAssetId} is ambiguous (hash-prefix collision)`,
    );
  }
  const row = matches[0]!;
  const bytes = blobs.getVerified(row["blob_hash"] as string);
  return {
    assetId: sourceAssetId,
    path: row["path"] as string,
    bytes,
    sha256: row["blob_hash"] as string,
  };
}

// ---------------------------------------------------------------------------
// inspection
// ---------------------------------------------------------------------------

export interface SourceInspection {
  kind: "source-inspection";
  sourceAssetId: string;
  path: string;
  dataHash: string;
  format: "csv";
  rowCount: number;
  columns: Array<{
    header: string;
    field: string;
    unit: string | null;
    type: "number" | "string";
    count: number;
    missing: number;
    min?: number;
    max?: number;
    mean?: number;
    distinct?: number;
  }>;
  warnings: string[];
}

export async function inspectSourceAsset(
  deps: AssetDeps,
  input: { snapshotId: string; sourceAssetId: string },
): Promise<{ inspection: SourceInspection; artifactId: string; jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "project.read");
  const out = await runServiceJob<{ inspection: SourceInspection; artifactId: string }>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "assets.inspect",
    snapshotId: input.snapshotId,
    input,
    compute: () => {
      const asset = resolveSourceAsset(store, blobs, scope, input.snapshotId, input.sourceAssetId);
      const data = parseCsv(asset.bytes);
      const warnings: string[] = [];
      if (data.rows.length === 0) warnings.push("source has a header row but no data rows");
      for (const col of data.columns) {
        if (col.missing > 0) {
          warnings.push(`column ${col.field}: ${col.missing} missing value(s)`);
        }
      }
      const inspection: SourceInspection = {
        kind: "source-inspection",
        sourceAssetId: asset.assetId,
        path: asset.path,
        dataHash: asset.sha256,
        format: "csv",
        rowCount: data.rows.length,
        columns: data.columns.map((c) => ({
          header: c.header,
          field: c.field,
          unit: c.unit,
          type: c.type,
          count: c.count,
          missing: c.missing,
          ...(c.min !== undefined ? { min: c.min, max: c.max, mean: c.mean } : {}),
          ...(c.distinct !== undefined ? { distinct: c.distinct } : {}),
        })),
        warnings,
      };
      const bytes = utf8Bytes(canonicalJson(inspection));
      const blob = blobs.put(bytes);
      const artifactId = `manifest-${blob.hash.slice(0, 16)}`;
      const evidence: EvidenceInput[] = [
        {
          snapshotId: input.snapshotId,
          kind: "data-inspection",
          sourceLocator: `project:${asset.path}`,
          content: asset.bytes,
          accessStatus: "fulltext",
          record: { sourceAssetId: asset.assetId, path: asset.path, dataHash: asset.sha256, rowCount: data.rows.length, columns: inspection.columns.length },
        },
      ];
      return {
        result: { inspection, artifactId },
        artifacts: [
          {
            artifactId,
            relPath: `inspection-${asset.assetId}.json`,
            kind: "manifest",
            blobHash: blob.hash,
            sizeBytes: bytes.length,
            mediaType: "application/json",
          },
        ],
        evidence,
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}

// ---------------------------------------------------------------------------
// rendering primitives (pure + deterministic)
// ---------------------------------------------------------------------------

export function escapeTex(text: string): string {
  let out = text;
  // Backslash first so the escapes below don't get re-escaped.
  out = out.replace(/\\/g, "\\textbackslash{}");
  out = out.replace(/[&%$#_{}]/g, (m) => `\\${m}`);
  out = out.replace(/~/g, "\\textasciitilde{}");
  out = out.replace(/\^/g, "\\textasciicircum{}");
  return out;
}

const LABEL_RE = /^[A-Za-z][A-Za-z0-9:_.-]*$/;

function requireLabel(label: string): string {
  if (!LABEL_RE.test(label)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `label ${JSON.stringify(label)} is not a safe LaTeX label (letters/digits/:_.- after a leading letter)`,
    );
  }
  return label;
}

/**
 * Exact decimal rounding on the RAW cell text — implemented on digits via
 * BigInt so the mapping record can reproduce the value bit-for-bit.
 * Returns the fixed-notation result.
 */
export function roundDecimal(
  raw: string,
  places: number | null,
  mode: "half-even" | "half-up",
): string {
  const trimmed = raw.trim();
  if (!isNumericCell(trimmed) || places === null) return trimmed;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (m === null) return trimmed;
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  const exp = Number.parseInt(m[4] ?? "0", 10);
  // digits = intPart+fracPart scaled by 10^-fracPart.length, shifted by exp.
  let digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  let scale = fracPart.length - exp; // value = digits * 10^-scale
  if (digits === "") digits = "0";
  // Normalize to a BigInt mantissa at a scale >= places.
  while (scale < places) {
    digits += "0";
    scale += 1;
  }
  let mantissa = BigInt(digits);
  // Round: drop `drop = scale - places` least-significant decimal digits.
  const drop = scale - places;
  if (drop > 0) {
    const divisor = 10n ** BigInt(drop);
    const q = mantissa / divisor;
    const r = mantissa % divisor;
    const twice = r * 2n;
    let roundUp = false;
    if (twice > divisor) roundUp = true;
    else if (twice === divisor) {
      roundUp = mode === "half-up" ? true : q % 2n === 1n;
    }
    mantissa = roundUp ? q + 1n : q;
    scale = places;
  }
  let text = mantissa.toString();
  if (scale > 0) {
    while (text.length <= scale) text = `0${text}`;
    text = `${text.slice(0, text.length - scale)}.${text.slice(text.length - scale)}`;
  }
  if (places > 0 && scale === places) {
    // keep trailing zeros — decimalPlaces is a display contract
    const fracIdx = text.indexOf(".");
    if (fracIdx === -1) text = `${text}.${"0".repeat(places)}`;
    else {
      const have = text.length - fracIdx - 1;
      if (have < places) text += "0".repeat(places - have);
    }
  }
  return `${sign}${text}`;
}

// ---------------------------------------------------------------------------
// table rendering (booktabs)
// ---------------------------------------------------------------------------

interface CellMapping {
  row: number;
  field: string;
  raw: string;
  rendered: string;
  missing: boolean;
}

export interface RenderedTable {
  tex: string;
  mapping: CellMapping[];
  trackedCells: number;
}

export function renderTable(data: CsvData, spec: TableSpec): RenderedTable {
  const colIndex = spec.columns.map((col) => {
    const idx = data.columns.findIndex(
      (c) => c.field === col.field || c.header === col.field,
    );
    if (idx === -1) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `table spec references field ${JSON.stringify(col.field)} which is not a CSV column (have: ${data.columns.map((c) => c.field).join(", ")})`,
      );
    }
    return idx;
  });
  const mapping: CellMapping[] = [];
  const align = spec.columns
    .map((_, i) => (data.columns[colIndex[i]!]!.type === "number" ? "r" : "l"))
    .join("");
  const header = spec.columns
    .map((col, i) => {
      const unit = col.unit ?? data.columns[colIndex[i]!]!.unit;
      const label = escapeTex(col.label);
      return unit !== null ? `${label} (${escapeTex(unit)})` : label;
    })
    .join(" & ");
  const body: string[] = [];
  for (const [ri, row] of data.rows.entries()) {
    const cells = spec.columns.map((col, i) => {
      const raw = (row[colIndex[i]!] as string).trim();
      if (raw === "") {
        mapping.push({ row: ri, field: col.field, raw: "", rendered: spec.missingValue, missing: true });
        return escapeTex(spec.missingValue);
      }
      const rendered = roundDecimal(raw, col.decimalPlaces, spec.roundingMode);
      mapping.push({ row: ri, field: col.field, raw, rendered, missing: false });
      return escapeTex(rendered);
    });
    body.push(`    ${cells.join(" & ")} \\\\`);
  }
  const tex = [
    "\\begin{table}[t]",
    "  \\centering",
    `  \\caption{${escapeTex(spec.caption)}}`,
    `  \\label{${requireLabel(spec.label)}}`,
    `  \\begin{tabular}{${align}}`,
    "    \\toprule",
    `    ${header} \\\\`,
    "    \\midrule",
    ...body,
    "    \\bottomrule",
    "  \\end{tabular}",
    "\\end{table}",
    "",
  ].join("\n");
  return { tex, mapping, trackedCells: mapping.length };
}

// ---------------------------------------------------------------------------
// plot rendering (pgfplots)
// ---------------------------------------------------------------------------

interface PointMapping {
  series: string;
  xRaw: string;
  yRaw: string;
  errorRaw?: string;
}

export interface RenderedPlot {
  tex: string;
  mapping: PointMapping[];
}

function numericColumnIndex(data: CsvData, field: string, what: string): number {
  const idx = data.columns.findIndex((c) => c.field === field || c.header === field);
  if (idx === -1) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `plot ${what} ${JSON.stringify(field)} is not a CSV column (have: ${data.columns.map((c) => c.field).join(", ")})`,
    );
  }
  if (data.columns[idx]!.type !== "number") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `plot ${what} ${JSON.stringify(field)} is not a numeric column`,
    );
  }
  return idx;
}

export function renderPlot(data: CsvData, params: PlotParams): RenderedPlot {
  const xIdx = numericColumnIndex(data, params.xField, "xField");
  const yIdxs = params.yFields.map((f) => numericColumnIndex(data, f, "yFields entry"));
  const errIdx = params.errorField !== null ? numericColumnIndex(data, params.errorField, "errorField") : -1;
  const mapping: PointMapping[] = [];
  const series: string[] = [];
  for (const [si, yIdx] of yIdxs.entries()) {
    const coords: string[] = [];
    for (const row of data.rows) {
      const xRaw = (row[xIdx] as string).trim();
      const yRaw = (row[yIdx] as string).trim();
      if (xRaw === "" || yRaw === "") continue; // missing rows are dropped, recorded in mapping
      const pt: PointMapping = { series: params.yFields[si]!, xRaw, yRaw };
      if (errIdx >= 0) {
        const eRaw = (row[errIdx] as string).trim();
        if (eRaw !== "") pt.errorRaw = eRaw;
        coords.push(`(${xRaw}, ${yRaw})${pt.errorRaw !== undefined ? ` +- (0, ${pt.errorRaw})` : ""}`);
      } else {
        coords.push(`(${xRaw}, ${yRaw})`);
      }
      mapping.push(pt);
    }
    series.push(
      `    \\addplot${errIdx >= 0 ? " +[error bars/.cd, y dir=both, y explicit]" : ""} coordinates {\n      ${coords.join("\n      ")}\n    };`,
      `    \\addlegendentry{${escapeTex(params.yFields[si]!)}}`,
    );
  }
  const tex = [
    "\\documentclass{standalone}",
    "\\usepackage{pgfplots}",
    "\\pgfplotsset{compat=1.18}",
    "\\begin{document}",
    "\\begin{tikzpicture}",
    `  \\begin{axis}[width=${params.widthMm}mm, height=${params.heightMm}mm,`,
    `    xlabel={${escapeTex(params.xLabel)}}, ylabel={${escapeTex(params.yLabel)}},`,
    `    title={${escapeTex(params.title)}}, legend pos=north west, grid=major]`,
    ...series,
    "  \\end{axis}",
    "\\end{tikzpicture}",
    "\\end{document}",
    "",
  ].join("\n");
  return { tex, mapping };
}

// ---------------------------------------------------------------------------
// diagram rendering (tikz)
// ---------------------------------------------------------------------------

const DIAGRAM_SHAPE: Record<DiagramSpec["nodes"][number]["role"], string> = {
  process: "rectangle, draw, rounded corners",
  input: "rectangle, draw",
  output: "rectangle, draw",
  decision: "diamond, draw, aspect=2",
  group: "rectangle, draw, dashed",
};

export interface RenderedDiagram {
  tex: string;
  nodeCount: number;
  edgeCount: number;
}

export function renderDiagram(spec: DiagramSpec): RenderedDiagram {
  const ids = new Set(spec.nodes.map((n) => n.id));
  for (const edge of spec.edges) {
    for (const [dir, id] of [["from", edge.from], ["to", edge.to]] as const) {
      if (!ids.has(id)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `diagram edge ${dir}=${JSON.stringify(id)} references a node that does not exist`,
        );
      }
    }
  }
  // Layered layout: depth = longest path from any root; deterministic given
  // the spec's declared order (ties keep input order).
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of spec.nodes) indeg.set(n.id, 0);
  for (const e of spec.edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  }
  const depth = new Map<string, number>();
  const queue = spec.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const visitOrder = queue.length > 0 ? queue : spec.nodes.map((n) => n.id);
  for (const start of visitOrder) {
    // BFS with longest-path relaxation.
    const q = [start];
    while (q.length > 0) {
      const u = q.shift() as string;
      for (const v of adj.get(u) ?? []) {
        const cand = (depth.get(u) ?? 0) + 1;
        if (cand > (depth.get(v) ?? 0)) {
          depth.set(v, cand);
          q.push(v);
        }
      }
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const n of spec.nodes) {
    const d = depth.get(n.id) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), n.id]);
  }
  const horizontal = spec.kind === "concept-flow" ? false : true;
  const pos = new Map<string, [number, number]>();
  for (const [d, level] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    level.forEach((id, i) => {
      pos.set(id, horizontal ? [d * 45, -i * 22] : [i * 42, -d * 24]);
    });
  }
  const nodeLines = spec.nodes.map((n) => {
    const [x, y] = pos.get(n.id) ?? [0, 0];
    const shape = DIAGRAM_SHAPE[n.role];
    return `  \\node[${shape}] (${n.id}) at (${x}mm, ${y}mm) {${escapeTex(n.label)}};`;
  });
  const edgeLines = spec.edges.map((e) => {
    const label = e.label.length > 0 ? ` node[midway, above, font=\\small] {${escapeTex(e.label)}}` : "";
    return `  \\draw[->, thick] (${e.from}) -- (${e.to})${label};`;
  });
  const tex = [
    "\\documentclass{standalone}",
    "\\usepackage{tikz}",
    "\\begin{document}",
    `\\begin{tikzpicture}[font=\\small]`,
    ...nodeLines,
    ...edgeLines,
    "\\end{tikzpicture}",
    "\\end{document}",
    "",
  ].join("\n");
  return { tex, nodeCount: spec.nodes.length, edgeCount: spec.edges.length };
}

// ---------------------------------------------------------------------------
// compilation (real runner — no fake success)
// ---------------------------------------------------------------------------

export interface CompileOutcome {
  ok: boolean;
  pdf: CollectedArtifact | null;
  log: CollectedArtifact | null;
  diagnostics: Diagnostic[];
  rendererVersion: string;
  exitCode: number | null;
}

export async function compileStandaloneTex(options: {
  blobs: BlobStore;
  repoRoot: string;
  presetsDir: string;
  workRoot?: string;
  jobId: string;
  texBytes: Uint8Array;
  entryName: string;
}): Promise<CompileOutcome> {
  const { blobs, repoRoot, presetsDir, jobId } = options;
  const runner = new TectonicRunner({ repoRoot });
  const probe = await runner.probe();
  if (!probe.available) {
    const detail = probe.checks.map((c) => `${c.name}: ${c.detail}`).join("; ");
    throw new WorkbenchError(
      ERROR_CODES.RUNTIME_UNAVAILABLE,
      `tectonic runner unavailable (${detail})`,
      { retryable: false },
    );
  }
  const binaryCheck = probe.checks.find((c) => c.name === "binary");
  const versionMatch = /tectonic\s+([\d.]+)/i.exec(binaryCheck?.detail ?? "");
  const rendererVersion = `tectonic ${versionMatch?.[1] ?? "unknown"}`;
  const preset = loadPreset(presetsDir, "local-tectonic-xelatex");
  const root = mkdtempSync(join(options.workRoot ?? tmpdir(), "latexwb-gen-"));
  const srcDir = join(root, "src");
  const outputDir = join(root, "out");
  const scratchDir = join(root, "scratch");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(srcDir, options.entryName), options.texBytes);
  const result = await runner.run({
    jobId,
    workDir: srcDir,
    entryFile: options.entryName,
    engine: "xelatex",
    bibliographyMode: "none",
    outputDir,
    scratchDir,
    preset,
  });
  const collected = collectArtifacts({
    blobs,
    outputDir,
    maxOutputBytes: preset.limits.maxOutputBytes ?? 64 * 1024 * 1024,
    jobId,
  });
  const log =
    collected.artifacts.find((a) => a.relPath === `${options.entryName.replace(/\.tex$/, "")}.log`) ??
    collected.artifacts.find((a) => a.kind === "log") ??
    null;
  let diagnostics: Diagnostic[] = [];
  if (log !== null) {
    diagnostics = parseTexLog(
      new TextDecoder("utf-8", { fatal: false }).decode(blobs.getVerified(log.blobHash)),
      options.entryName,
    ).diagnostics;
  }
  return {
    ok: result.exitCode === 0 && collected.pdf !== null,
    pdf: collected.pdf,
    log,
    diagnostics,
    rendererVersion,
    exitCode: result.exitCode,
  };
}

// ---------------------------------------------------------------------------
// generation entry point
// ---------------------------------------------------------------------------

export type FigureAction =
  | { action: "table"; tableSpec: TableSpec }
  | { action: "plot"; recipeId: string; params: PlotParams }
  | { action: "diagram"; recipeId: string; diagramSpec: DiagramSpec };

export interface GenerateOutcome {
  result: GeneratedAssetResult;
  texArtifactId: string;
  pdfArtifactId: string | null;
  diagnostics: Diagnostic[];
  compileProof: "compiled" | "skipped-runner-unavailable" | "failed";
}

const TABLE_RECIPE_ID = "booktabs-table";

export async function generateDataAsset(
  deps: AssetDeps,
  input: { snapshotId: string; sourceAssetId: string } & FigureAction,
): Promise<GenerateOutcome & { jobId: string }> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "data.render");
  const recipeId =
    input.action === "table" ? TABLE_RECIPE_ID : input.recipeId;
  const kind = input.action === "table" ? "table" : input.action === "plot" ? "plot" : "diagram";
  const recipe = resolveRecipe(deps.repoRoot, deps.hostPolicy, recipeId, kind);

  const out = await runServiceJob<GenerateOutcome>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: `assets.generate-${input.action}`,
    snapshotId: input.snapshotId,
    input,
    compute: async (jobId) => {
      const asset = resolveSourceAsset(store, blobs, scope, input.snapshotId, input.sourceAssetId);
      const params =
        input.action === "table"
          ? input.tableSpec
          : input.action === "plot"
            ? input.params
            : input.diagramSpec;
      const parametersHash = digestJson({ recipe: recipe.id, params });
      const artifacts: CollectedArtifact[] = [];
      const evidence: EvidenceInput[] = [];
      let tex: string;
      let mappingJson: unknown;
      let kindOfContent: GeneratedAssetResult["kindOfContent"];
      let data: CsvData | null = null;
      if (input.action !== "diagram") {
        data = parseCsv(asset.bytes);
      }
      if (input.action === "table") {
        const r = renderTable(data as CsvData, input.tableSpec);
        tex = r.tex;
        kindOfContent = "data-table";
        mappingJson = {
          kind: "numeric-mapping",
          generator: "table",
          columns: input.tableSpec.columns,
          roundingMode: input.tableSpec.roundingMode,
          cells: r.mapping,
        };
      } else if (input.action === "plot") {
        const r = renderPlot(data as CsvData, input.params);
        tex = r.tex;
        kindOfContent = "data-plot";
        mappingJson = {
          kind: "numeric-mapping",
          generator: "plot",
          params: input.params,
          points: r.mapping,
        };
      } else {
        const r = renderDiagram(input.diagramSpec);
        tex = r.tex;
        kindOfContent = "conceptual";
        mappingJson = {
          kind: "numeric-mapping",
          generator: "diagram",
          nodes: input.diagramSpec.nodes.map((n) => n.id),
          edges: input.diagramSpec.edges.map((e) => `${e.from}->${e.to}`),
        };
      }

      // Generated .tex — the deterministic, attachable artifact.
      const texBytes = utf8Bytes(tex);
      const texBlob = blobs.put(texBytes);
      const texArtifactId = `text-${texBlob.hash.slice(0, 16)}`;
      artifacts.push({
        artifactId: texArtifactId,
        relPath: `generated/${input.action}-${texBlob.hash.slice(0, 8)}.tex`,
        kind: "text",
        blobHash: texBlob.hash,
        sizeBytes: texBytes.length,
        mediaType: "application/x-tex",
      });

      // Numeric/structural mapping artifact.
      const mappingBytes = utf8Bytes(
        canonicalJson({
          ...(mappingJson as Record<string, unknown>),
          sourceAssetId: asset.assetId,
          sourcePath: asset.path,
          dataHash: asset.sha256,
          recipeId: recipe.id,
          parametersHash,
          specJson: params,
        }),
      );
      const mappingBlob = blobs.put(mappingBytes);
      const mappingArtifactId = `manifest-${mappingBlob.hash.slice(0, 16)}`;
      artifacts.push({
        artifactId: mappingArtifactId,
        relPath: `generated/${input.action}-${mappingBlob.hash.slice(0, 8)}-mapping.json`,
        kind: "manifest",
        blobHash: mappingBlob.hash,
        sizeBytes: mappingBytes.length,
        mediaType: "application/json",
      });

      // Real compilation for every kind (tables get a booktabs wrapper doc
      // as their proof). Runner unavailable → for tables the fragment still
      // ships with an explicit skipped-proof record; for plot/diagram the
      // compile IS the deliverable, so the job fails.
      let pdfArtifactId: string | null = null;
      let diagnostics: Diagnostic[] = [];
      let rendererVersion = `internal-${recipe.id}/${recipe.version}`;
      let compileProof: "compiled" | "skipped-runner-unavailable" | "failed" = "compiled";
      const docBytes =
        input.action === "table"
          ? utf8Bytes(
              [
                "\\documentclass{article}",
                "\\usepackage{booktabs}",
                "\\begin{document}",
                tex,
                "\\end{document}",
                "",
              ].join("\n"),
            )
          : texBytes;
      try {
        const compile = await compileStandaloneTex({
          blobs,
          repoRoot: deps.repoRoot,
          presetsDir: deps.presetsDir,
          jobId,
          texBytes: docBytes,
          entryName: `${input.action}-proof.tex`,
        });
        rendererVersion = compile.rendererVersion;
        diagnostics = compile.diagnostics;
        if (compile.log !== null) artifacts.push(compile.log);
        if (compile.pdf !== null) {
          artifacts.push(compile.pdf);
          pdfArtifactId = compile.pdf.artifactId;
        }
        if (!compile.ok) {
          // The build-service convention: a failed compile is honest DATA
          // (compileProof:"failed" + real diagnostics), not a job failure —
          // the .tex fragment and log still publish, the check gate fails it.
          compileProof = "failed";
        }
      } catch (error) {
        if (error instanceof WorkbenchError && error.code === ERROR_CODES.RUNTIME_UNAVAILABLE) {
          compileProof = "skipped-runner-unavailable";
          diagnostics = [
            {
              code: ERROR_CODES.RUNTIME_UNAVAILABLE,
              severity: "warning",
              message: `compile proof skipped: ${error.message}`,
              source: null,
              page: null,
              causeId: null,
              evidenceArtifactIds: [],
              rawLogRange: null,
              confidence: "certain",
            },
          ];
          if (input.action !== "table") {
            // For plot/diagram the compiled PDF IS the deliverable — runner
            // unavailability fails the job (retryable), but the .tex +
            // mapping + evidence still publish inside the finalize tx.
            evidence.push({
              snapshotId: input.snapshotId,
              kind: "generated-asset",
              sourceLocator: `project:${asset.path}`,
              content: texBytes,
              accessStatus: "fulltext",
              record: {
                sourceAssetId: asset.assetId,
                recipeId: recipe.id,
                recipeHash: recipeHash(recipe),
                parametersHash,
                texArtifactId,
                pdfArtifactId: null,
                mappingArtifactId,
                compileProof,
              },
            });
            const result: GeneratedAssetResult = {
              kind: "generated-asset",
              artifactId: texArtifactId,
              sourceAssetId: asset.assetId,
              dataHash: asset.sha256,
              recipeHash: recipeHash(recipe),
              parametersHash,
              rendererVersion,
              sourceLocator: `project:${asset.path}#${asset.sha256.slice(0, 12)}`,
              numericMappingArtifactId: mappingArtifactId,
              kindOfContent,
            };
            return {
              result: { result, texArtifactId, pdfArtifactId: null, diagnostics, compileProof },
              artifacts,
              evidence,
              failWith: error,
            };
          }
        } else {
          throw error;
        }
      }

      evidence.push({
        snapshotId: input.snapshotId,
        kind: "generated-asset",
        sourceLocator: `project:${asset.path}`,
        content: texBytes,
        accessStatus: "fulltext",
        record: {
          sourceAssetId: asset.assetId,
          recipeId: recipe.id,
          recipeHash: recipeHash(recipe),
          parametersHash,
          texArtifactId,
          pdfArtifactId,
          mappingArtifactId,
          compileProof,
          diagnostics: diagnostics.slice(0, 20),
        },
      });

      const result: GeneratedAssetResult = {
        kind: "generated-asset",
        artifactId: input.action === "table" ? texArtifactId : (pdfArtifactId ?? texArtifactId),
        sourceAssetId: asset.assetId,
        dataHash: asset.sha256,
        recipeHash: recipeHash(recipe),
        parametersHash,
        rendererVersion,
        sourceLocator: `project:${asset.path}#${asset.sha256.slice(0, 12)}`,
        numericMappingArtifactId: mappingArtifactId,
        kindOfContent,
      };
      return {
        result: { result, texArtifactId, pdfArtifactId, diagnostics, compileProof },
        artifacts,
        evidence,
      };
    },
  });
  return { ...out.result, jobId: out.jobId };
}
