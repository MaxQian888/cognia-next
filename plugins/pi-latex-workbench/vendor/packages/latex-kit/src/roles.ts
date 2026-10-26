/**
 * File-role classification by project path (extension / well-known name).
 * Roles drive protection: `template` and `raw-asset` files are protected
 * whole-file by `analyzeProtectedChanges`, `source` files are scanned.
 */

/**
 * Role a file gets from its project-relative path alone: "bibliography",
 * "provided-bbl", "source", "project-config" or "raw-asset".
 */
export function classifyRole(projectPath: string): string {
  const lower = projectPath.toLowerCase();
  if (lower.endsWith(".bib")) return "bibliography";
  if (lower.endsWith(".bbl")) return "provided-bbl";
  if (/\.(tex|ltx|sty|cls|def|clo|dtx|ins|cfg|fd|ldf|biblatex\.conf)$/.test(lower)) return "source";
  if (/(^|\/)(latexmkrc|\.latexmkrc|arara\.yaml|arara\.yml|makefile|\.chktexrc|latexmkrcextra)/.test(lower)) {
    return "project-config";
  }
  return "raw-asset";
}
