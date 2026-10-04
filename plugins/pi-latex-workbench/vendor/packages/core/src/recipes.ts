/**
 * Trusted generation recipes (M3). A recipe is a HOST-owned entry in
 * resources/recipes/registry.json — the registry is configuration, not
 * project content. `allowArbitraryRecipes` in the host policy is the only
 * switch that relaxes registry membership; project-supplied recipe text is
 * never executable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  WorkbenchError,
  type HostPolicy,
} from "@latexwb/contracts";

export type RecipeKind = "table" | "plot" | "diagram";

export interface RecipeEntry {
  id: string;
  kind: RecipeKind;
  version: string;
  description: string;
  /** LaTeX packages the generated output requires — used for preflight. */
  requiredPackages: string[];
}

interface RecipeRegistryFile {
  schemaVersion: number;
  recipes: RecipeEntry[];
}

export function loadRecipeRegistry(repoRoot: string): RecipeEntry[] {
  const path = join(repoRoot, "resources", "recipes", "registry.json");
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as RecipeRegistryFile;
  if (!Array.isArray(raw.recipes)) {
    throw new WorkbenchError(
      ERROR_CODES.CONFIG_INVALID,
      `recipe registry ${path} has no 'recipes' array`,
    );
  }
  for (const r of raw.recipes) {
    if (
      typeof r.id !== "string" ||
      !["table", "plot", "diagram"].includes(r.kind) ||
      typeof r.version !== "string"
    ) {
      throw new WorkbenchError(
        ERROR_CODES.CONFIG_INVALID,
        `recipe registry entry ${JSON.stringify(r)} is malformed`,
      );
    }
  }
  return raw.recipes;
}

export function recipeHash(recipe: RecipeEntry): string {
  return sha256Hex(utf8Bytes(canonicalJson(recipe)));
}

/**
 * Resolve a recipe id for a generation kind. The registry is authoritative:
 * an unlisted id is POLICY_DENIED unless the host explicitly opted into
 * arbitrary recipes — and even then the "recipe" is only a named parameter
 * preset, never code.
 */
export function resolveRecipe(
  repoRoot: string,
  policy: HostPolicy | null,
  recipeId: string,
  kind: RecipeKind,
): RecipeEntry {
  const entry = loadRecipeRegistry(repoRoot).find((r) => r.id === recipeId);
  if (entry === undefined) {
    // HostPolicy.allowArbitraryRecipes is `const false` in the contract —
    // an unlisted recipe can never be admitted by a valid policy.
    throw new WorkbenchError(
      ERROR_CODES.POLICY_DENIED,
      `recipe ${JSON.stringify(recipeId)} is not in resources/recipes/registry.json (host policy forbids arbitrary recipes)`,
    );
  }
  if (entry.kind !== kind) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `recipe ${recipeId} is a ${entry.kind} recipe, not ${kind}`,
    );
  }
  return entry;
}
