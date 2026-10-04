/**
 * Static project inspection over snapshot contents (from CAS). Produces the
 * schema ProjectInspection: root candidates ranked by evidence strength,
 * include-graph, packages/fonts/languages, bibliography mode, assets,
 * generated-file awareness, and UNTRUSTED config files that are registered
 * but NEVER executed (latexmkrc/arara/Makefile are data, not commands).
 *
 * Macro expansion is not attempted; the include graph is a candidate graph
 * refined later by real .fls/deps manifests.
 */
import {
  canonicalJson,
  digestJson,
  ERROR_CODES,
  utcNowIso,
  WorkbenchError,
  type Diagnostic,
  type ProjectInspection,
  type Target,
} from "@latexwb/contracts";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { readSnapshotFile } from "./snapshot.ts";
import { posix } from "node:path";

const TEX_EXTS = /\.(tex|ltx|sty|cls|dtx)$/i;

const INCLUDE_RE =
  /\\(?:input|include|subfile|subfileinclude|import|subimport)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}|\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}|\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}|\\bibliography\s*\{([^}]+)\}/g;
const DOCCLASS_RE = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/;
const BEGINDOC_RE = /\\begin\{document\}/;
const MAGIC_ROOT_RE = /^\s*%\s*!T[Ee]X\s+root\s*=\s*(.+?)\s*$/m;
const MAGIC_PROGRAM_RE = /^\s*%\s*!T[Ee]X\s+program\s*=\s*(\S+)/im;
const USEPACKAGE_RE = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
const REQUIREPACKAGE_RE = /\\RequirePackage\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
const SETFONT_RE = /\\set(?:main|sans|mono|CJKmain|CJKsans|CJKmono)font\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
const FONTSET_RE = /fontset\s*=\s*([A-Za-z]+)/;
const BIBLATEX_BACKEND_RE = /\\usepackage\s*\[([^\]]*)\]\s*\{biblatex\}|\\addbibresource|backend\s*=\s*(bibtex|biber)/;
const UNTRUSTED_NAMES = new Set([
  "latexmkrc",
  ".latexmkrc",
  "makefile",
  "arara.yaml",
  "arara.yml",
  ".chktexrc",
  "latexmkrc.pl",
]);
const DYNAMIC_PACKAGES = new Set([
  "minted",
  "pythontex",
  "asymptote",
  "svg",
  "gnuplottex",
  "sagetex",
]);

interface TexInfo {
  path: string;
  text: string;
  hasDocclass: boolean;
  hasBeginDoc: boolean;
  docclass: string | null;
  docclassOptions: string | null;
  magicRoot: string | null;
  magicProgram: string | null;
  includes: { kind: string; target: string }[];
  packages: string[];
  fonts: string[];
}

function analyzeTex(path: string, text: string): TexInfo {
  const doc = DOCCLASS_RE.exec(text);
  const magicRoot = MAGIC_ROOT_RE.exec(text);
  const magicProgram = MAGIC_PROGRAM_RE.exec(text);
  const includes: { kind: string; target: string }[] = [];
  let m: RegExpExecArray | null;
  const incRe = new RegExp(INCLUDE_RE.source, "g");
  while ((m = incRe.exec(text)) !== null) {
    if (m[1] !== undefined) includes.push({ kind: "input", target: m[1] });
    else if (m[2] !== undefined) includes.push({ kind: "graphics", target: m[2] });
    else if (m[3] !== undefined) includes.push({ kind: "bibresource", target: m[3] });
    else if (m[4] !== undefined) includes.push({ kind: "bibliography", target: m[4] });
  }
  const packages = new Set<string>();
  for (const re of [USEPACKAGE_RE, REQUIREPACKAGE_RE]) {
    const clone = new RegExp(re.source, "g");
    let pm: RegExpExecArray | null;
    while ((pm = clone.exec(text)) !== null) {
      for (const name of (pm[2] ?? "").split(",")) {
        const p = name.trim();
        if (p.length > 0) packages.add(p);
      }
    }
  }
  const fonts = new Set<string>();
  const fontRe = new RegExp(SETFONT_RE.source, "g");
  let fm: RegExpExecArray | null;
  while ((fm = fontRe.exec(text)) !== null) {
    if (fm[1] !== undefined) fonts.add(fm[1].trim());
  }
  const fontset = FONTSET_RE.exec(doc?.[1] ?? text);
  if (fontset !== null) fonts.add(`fontset=${fontset[1]}`);

  return {
    path,
    text,
    hasDocclass: doc !== null,
    hasBeginDoc: BEGINDOC_RE.test(text),
    docclass: doc?.[2] ?? null,
    docclassOptions: doc?.[1] ?? null,
    magicRoot: magicRoot?.[1]?.trim() ?? null,
    magicProgram: magicProgram?.[1]?.trim() ?? null,
    includes,
    packages: [...packages],
    fonts: [...fonts],
  };
}

function detectLanguages(tex: TexInfo[], docclass: string | null): string[] {
  const langs = new Set<string>();
  for (const t of tex) {
    if (t.docclass !== null && /^ctex/.test(t.docclass)) langs.add("zh");
    if (t.packages.some((p) => p === "ctex" || p === "xeCJK" || p === "CJKutf8")) langs.add("zh");
    const babel = t.packages.find((p) => p === "babel");
    if (babel !== undefined) {
      const m = /\\usepackage\s*\[([^\]]*)\]\s*\{babel\}/.exec(t.text);
      for (const lang of (m?.[1] ?? "").split(",")) {
        const l = lang.trim();
        if (l.length > 0) langs.add(l);
      }
    }
    if (t.packages.includes("polyglossia")) {
      const m = /\\setmainlanguage\s*\{([^}]+)\}/.exec(t.text);
      if (m !== null) langs.add((m[1] as string).trim());
    }
  }
  if (langs.size === 0) langs.add("en");
  return [...langs];
}

function detectEngine(tex: TexInfo[], docclass: string | null): "pdflatex" | "xelatex" | "lualatex" | null {
  for (const t of tex) {
    if (t.magicProgram !== null) {
      const p = t.magicProgram.toLowerCase();
      if (p.includes("xelatex") || p.includes("xetex")) return "xelatex";
      if (p.includes("lualatex") || p.includes("luatex")) return "lualatex";
      if (p.includes("pdflatex") || p.includes("pdftex")) return "pdflatex";
    }
  }
  for (const t of tex) {
    if (t.packages.includes("luacode") || t.packages.includes("luatex85")) return "lualatex";
    if (
      t.packages.some((p) => ["fontspec", "xecjk", "unicode-math", "ctex"].includes(p)) ||
      (docclass !== null && /^ctex/.test(docclass))
    ) {
      return "xelatex";
    }
  }
  return null; // no strong signal — caller picks the preset default
}

function detectBibliographyMode(
  tex: TexInfo[],
  filePaths: Set<string>,
): "none" | "bibtex" | "biber" | "provided-bbl" {
  let hasBbl = false;
  for (const p of filePaths) {
    if (p.toLowerCase().endsWith(".bbl")) hasBbl = true;
  }
  let wantsBiber = false;
  let wantsBibtex = false;
  for (const t of tex) {
    const backend = /backend\s*=\s*(biber|bibtex)/.exec(t.text);
    if (backend !== null) {
      if (backend[1] === "biber") wantsBiber = true;
      else wantsBibtex = true;
    }
    if (t.includes.some((i) => i.kind === "bibresource")) {
      // biblatex: default backend is biber unless overridden
      if (!wantsBibtex) wantsBiber = true;
    }
    if (t.includes.some((i) => i.kind === "bibliography") || /\\bibliographystyle/.test(t.text)) {
      wantsBibtex = true;
    }
  }
  if (wantsBiber) return "biber";
  if (wantsBibtex) return "bibtex";
  if (hasBbl) return "provided-bbl";
  return "none";
}

function inferOutputProfile(docclass: string | null): Target["outputProfileId"] {
  if (docclass === null) return "article";
  if (/^beamer/.test(docclass)) return "beamer";
  if (/^ctex/.test(docclass)) return "zh-thesis";
  if (/^(book|report|scrreprt|scrbook)/.test(docclass)) return "book-report";
  if (/^(moderncv|curve|res)/.test(docclass)) return "cv-letter";
  if (/^(exam|esami)/.test(docclass)) return "exam-student";
  if (/^poster|tikzposter|baposter|a0poster/.test(docclass)) return "poster";
  return "article";
}

export interface InspectOptions {
  store: WorkbenchStore;
  blobs: BlobStore;
  scope: Scope;
  snapshotId: string;
  projectId: string;
  /** Persisted targets from earlier config (explicit candidates). */
  existingTargets?: Target[];
}

export function inspectProject(options: InspectOptions): ProjectInspection {
  const { store, blobs, scope, snapshotId, projectId } = options;
  const files = store.listSnapshotFiles(scope, snapshotId);
  const filePaths = new Set(files.map((f) => f["path"] as string));

  const texFiles: TexInfo[] = [];
  const untrusted: string[] = [];
  const bibliographyPaths: string[] = [];
  const assets: ProjectInspection["assets"] = [];

  for (const row of files) {
    const path = row["path"] as string;
    const base = path.split("/").pop() ?? path;
    if (UNTRUSTED_NAMES.has(base.toLowerCase())) untrusted.push(path);
    if (path.toLowerCase().endsWith(".bib")) bibliographyPaths.push(path);
    const role = row["role"] as string;
    if (role === "raw-asset" || role === "generated-asset") {
      assets.push({
        id: `asset-${(row["blob_hash"] as string).slice(0, 12)}`,
        path,
        snapshotId,
        sha256: row["blob_hash"] as string,
        bytes: row["size_bytes"] as number,
        mediaType: "application/octet-stream",
        role: role as "raw-asset" | "generated-asset",
        sourceLocator: `cas:${row["blob_hash"]}`,
      });
    }
    if (TEX_EXTS.test(path)) {
      const bytes = readSnapshotFile({ store, blobs, scope, snapshotId, path });
      if (bytes !== null) {
        texFiles.push(analyzeTex(path, new TextDecoder("utf8", { fatal: false }).decode(bytes)));
      }
    }
  }

  // ---- root candidates -------------------------------------------------
  const candidates: ProjectInspection["rootCandidates"] = [];
  const explicitTargets = options.existingTargets ?? [];
  for (const t of explicitTargets) {
    if (filePaths.has(t.root)) {
      candidates.push({ path: t.root, reason: `explicit target ${t.id}`, confidence: "explicit" });
    }
  }
  // % !TEX root magic chains: file A declares root R → R is a candidate.
  for (const t of texFiles) {
    if (t.magicRoot !== null) {
      const dir = posix.dirname(t.path) === "." ? "" : `${posix.dirname(t.path)}/`;
      const resolved = posix.normalize(dir + t.magicRoot);
      if (filePaths.has(resolved)) {
        candidates.push({ path: resolved, reason: `% !TEX root declared by ${t.path}`, confidence: "explicit" });
      }
    }
  }
  const fullEntries = texFiles.filter((t) => t.hasDocclass && t.hasBeginDoc);
  if (candidates.length === 0) {
    if (fullEntries.length === 1) {
      candidates.push({
        path: (fullEntries[0] as TexInfo).path,
        reason: "documentclass + \\begin{document} entry",
        confidence: "inferred",
      });
    } else {
      for (const t of fullEntries) {
        candidates.push({
          path: t.path,
          reason: "one of several complete document entries",
          confidence: "ambiguous",
        });
      }
      // include-graph root inference: files included by nobody are roots.
      const includedTargets = new Set<string>();
      for (const t of texFiles) {
        const dir = posix.dirname(t.path) === "." ? "" : `${posix.dirname(t.path)}/`;
        for (const inc of t.includes) {
          if (inc.kind !== "input") continue;
          const norm = posix.normalize(dir + inc.target);
          for (const cand of [norm, `${norm}.tex`]) {
            if (filePaths.has(cand)) includedTargets.add(cand);
          }
        }
      }
      if (candidates.length === 0) {
        for (const t of texFiles) {
          if (t.hasDocclass && !includedTargets.has(t.path)) {
            candidates.push({ path: t.path, reason: "documentclass root in include graph", confidence: "ambiguous" });
          }
        }
      }
    }
  }

  const diagnostics: Diagnostic[] = [];
  const ambiguous = candidates.filter((c) => c.confidence === "ambiguous");
  if (candidates.length === 0) {
    diagnostics.push({
      code: "NOT_FOUND",
      severity: "error",
      message: "no root .tex candidate found in snapshot",
      source: null,
      page: null,
      causeId: null,
      evidenceArtifactIds: [],
      rawLogRange: null,
      confidence: "certain",
    });
  } else if (ambiguous.length > 1 || (candidates.length > 1 && candidates.every((c) => c.confidence === "ambiguous"))) {
    diagnostics.push({
      code: ERROR_CODES.TARGET_AMBIGUOUS,
      severity: "error",
      message: `${ambiguous.length} ambiguous root candidates; pass --target to disambiguate`,
      source: null,
      page: null,
      causeId: null,
      evidenceArtifactIds: [],
      rawLogRange: null,
      confidence: "certain",
    });
  }

  const docclass = texFiles.find((t) => t.hasDocclass)?.docclass ?? null;
  const packages = [...new Set(texFiles.flatMap((t) => t.packages))].sort();
  const fonts = [...new Set(texFiles.flatMap((t) => t.fonts))].sort();
  const dynamic = packages.some((p) => DYNAMIC_PACKAGES.has(p));

  return {
    kind: "inspection",
    projectId,
    sourceManifestArtifactId: null,
    bibliographyPaths: bibliographyPaths.sort(),
    assets,
    headSnapshotId: snapshotId,
    targets: explicitTargets,
    rootCandidates: candidates,
    languages: detectLanguages(texFiles, docclass),
    packages,
    fonts,
    dynamicDependencies: dynamic,
    untrustedConfigFiles: untrusted.sort(),
    diagnostics,
  };
}

export interface InspectionDerived {
  docclass: string | null;
  engine: "pdflatex" | "xelatex" | "lualatex" | null;
  bibliographyMode: "none" | "bibtex" | "biber" | "provided-bbl";
  outputProfileId: Target["outputProfileId"];
}

/**
 * The engine/bibliography/profile conclusions drawn during inspection. Kept
 * separate from ProjectInspection (whose shape is schema-fixed) but computed
 * in the same pass.
 */
export function inspectDerived(options: InspectOptions): {
  inspection: ProjectInspection;
  derived: InspectionDerived;
} {
  const inspection = inspectProject(options);
  const { store, blobs, scope, snapshotId } = options;
  const texFiles: TexInfo[] = [];
  for (const row of store.listSnapshotFiles(scope, snapshotId)) {
    const path = row["path"] as string;
    if (TEX_EXTS.test(path)) {
      const bytes = readSnapshotFile({ store, blobs, scope, snapshotId, path });
      if (bytes !== null) {
        texFiles.push(analyzeTex(path, new TextDecoder("utf8", { fatal: false }).decode(bytes)));
      }
    }
  }
  const docclass = texFiles.find((t) => t.hasDocclass)?.docclass ?? null;
  const filePaths = new Set(
    store.listSnapshotFiles(scope, snapshotId).map((f) => f["path"] as string),
  );
  return {
    inspection,
    derived: {
      docclass,
      engine: detectEngine(texFiles, docclass),
      bibliographyMode: detectBibliographyMode(texFiles, filePaths),
      outputProfileId: inferOutputProfile(docclass),
    },
  };
}

export interface ResolvedTarget {
  target: Target;
}

/**
 * Turn an inspection into a concrete Target: prefer explicit/requested id,
 * else the single unambiguous root. Ambiguity is the caller's problem —
 * this helper returns the highest-confidence single candidate or null.
 */
export function resolveTarget(
  inspection: ProjectInspection,
  derived: InspectionDerived,
  options: {
    requestedTargetId?: string | null;
    engineFallback: "pdflatex" | "xelatex" | "lualatex";
    presetForEngine: (engine: "pdflatex" | "xelatex" | "lualatex") => string;
  },
): Target | null {
  const existing = inspection.targets;
  if (options.requestedTargetId !== undefined && options.requestedTargetId !== null) {
    const found = existing.find((t) => t.id === options.requestedTargetId);
    if (found !== undefined) return found;
    throw new WorkbenchError(
      ERROR_CODES.NOT_FOUND,
      `target ${options.requestedTargetId} does not exist`,
    );
  }
  if (existing.length > 0) return existing[0] as Target;

  const explicit = inspection.rootCandidates.filter((c) => c.confidence === "explicit");
  const inferred = inspection.rootCandidates.filter((c) => c.confidence === "inferred");
  const chosen = explicit[0] ?? inferred[0] ?? null;
  if (chosen === null) return null;

  const engine = derived.engine ?? options.engineFallback;
  return {
    id: "default",
    root: chosen.path,
    workingDirectory: chosen.path.includes("/") ? "entry-parent" : "project-root",
    engine,
    bibliography: derived.bibliographyMode,
    outputProfileId: derived.outputProfileId,
    venueProfileId: null,
    buildPresetId: options.presetForEngine(engine),
  };
}
