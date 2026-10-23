/**
 * Source scanners behind submission checks: identifying information in an
 * anonymous submission, files the sources reference, and declared sections.
 */

/** Anonymization scan patterns. */
export const ANON_PATTERNS: Array<{ id: string; re: RegExp; where: string }> = [
  { id: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, where: "email address" },
  {
    id: "author-block",
    re: /\\author\s*(?:\[[^\]]*\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
    where: "\\author{…} content",
  },
  { id: "affiliation", re: /\\(?:affiliation|affil|institute|institution|address)\s*\{[^}]*\}/g, where: "affiliation command" },
  { id: "orcid", re: /(?:orcid|ORCID)\s*[:={]?\s*\d{4}-\d{4}-\d{4}-\d{3}[\dX]/g, where: "ORCID id" },
  { id: "corresponding", re: /[Cc]orresponding\s+[Aa]uthor/g, where: "corresponding-author marker" },
  { id: "thanks", re: /\\thanks\s*\{[^}]*\}/g, where: "\\thanks{…} (often carries names/affiliation)" },
];

export interface AnonFinding {
  where: string;
  match: string;
  /** "source:<path>" or "pdf:page-<n>" */
  location: string;
}

/**
 * Identifying information in sources (comments included: source archives
 * ship them) and, when given, in the text of rendered PDF pages.
 */
export function anonymizationScan(
  sources: Map<string, string>,
  pdfPages: ReadonlyArray<{ page: number; text: string }> | null,
): AnonFinding[] {
  const findings: AnonFinding[] = [];
  const scan = (text: string, location: string): void => {
    for (const { id, re, where } of ANON_PATTERNS) {
      const r = new RegExp(re.source, re.flags);
      let m: RegExpExecArray | null;
      while ((m = r.exec(text)) !== null) {
        const body = id === "author-block" ? (m[1] ?? "") : m[0];
        // An EMPTY \author{} is anonymous-by-omission — not a finding.
        if (body.trim().length === 0) continue;
        findings.push({ where, match: m[0].slice(0, 120), location });
      }
    }
  };
  for (const [path, text] of sources) scan(text, `source:${path}`);
  if (pdfPages !== null) {
    for (const p of pdfPages) scan(p.text, `pdf:page-${p.page}`);
  }
  return findings;
}

/** All \includegraphics/\input/\include/\addbibresource targets in tex. */
export function referencedAssets(texSources: Map<string, string>): Array<{ from: string; target: string }> {
  const out: Array<{ from: string; target: string }> = [];
  const re = /\\(?:includegraphics|input|include|addbibresource|bibliography)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (const [path, text] of texSources) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(text)) !== null) {
      for (const t of (m[1] as string).split(",")) {
        const target = t.trim();
        if (target.length > 0) out.push({ from: path, target });
      }
    }
  }
  return out;
}

/** Strip LaTeX comments: an unescaped '%' ends the line. */
export function stripTexComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** Section titles declared in tex sources (\section/\chapter/\subsection). */
export function declaredSections(texSources: Map<string, string>): Set<string> {
  const out = new Set<string>();
  const re = /\\(?:section|chapter|subsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  for (const text of texSources.values()) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(text)) !== null) {
      out.add((m[1] as string).replace(/\s+/g, " ").trim());
    }
  }
  return out;
}
