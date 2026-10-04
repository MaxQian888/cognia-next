/**
 * Workflow definition loading + validation (M2-B). Definitions are host
 * resources only: JSON files under `resources/workflows/*.json`, never
 * loaded from a project tree, never evaluated, never dynamically imported.
 *
 * A definition is identified by content: `definitionHash =
 * sha256(canonicalJson(spec))`. `startWorkflow` stores the canonical spec
 * bytes in CAS and records the hash on the workflow row; resume loads the
 * definition FROM CAS by that hash, so editing a JSON file on disk can never
 * retroactively change a running workflow — a new run picks up the new hash.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  formatErrors,
  sha256Hex,
  utf8Bytes,
  validatorFor,
  WorkbenchError,
  type WorkflowSpec,
} from "@latexwb/contracts";
import type { BlobStore } from "@latexwb/storage";

/** Declared fields of the workflow context — the only legal binding targets. */
export const WORKFLOW_CONTEXT_FIELDS: ReadonlySet<string> = new Set([
  "snapshotId",
  "targetId",
  "pdfArtifactId",
  "patchId",
  "causeId",
  "baselineArtifactId",
  // M3
  "templateId",
  "initTargetId",
  "bibPaths",
  "candidateIds",
  "missingBibKeys",
  "bibReportArtifactId",
  "auditReportArtifactId",
  "dataAssetIds",
  "generatedArtifactId",
  "checkReportArtifactId",
  "assetSpec",
  "noChange",
  // M4
  "releaseId",
  "releaseProfileId",
  "whitelistDigest",
  "whitelistArtifactId",
  "sourceZipArtifactId",
  "packageManifestArtifactId",
  "rebuildJobId",
]);

const BINDING_PATTERN = /^context\.[A-Za-z][A-Za-z0-9_]*$/;

export interface LoadedWorkflowDef {
  spec: WorkflowSpec;
  /** sha256 of canonicalJson(spec) — the identity a running workflow pins to. */
  hash: string;
  /** Canonical bytes, what gets stored in CAS. */
  bytes: Uint8Array;
}

export interface OperationRegistryEntry {
  id: string;
  type: string;
  implementationStatus?: string;
  unsupportedReason?: string;
  description?: string;
}

export function loadOperationRegistry(repoRoot: string): OperationRegistryEntry[] {
  const path = join(repoRoot, "resources", "workflows", "operation-registry.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as { operations: OperationRegistryEntry[] };
  return raw.operations;
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `workflow resource ${path} is not valid JSON: ${String(error)}`,
    );
  }
}

/**
 * Semantic validation beyond the WorkflowSpec schema — every violation is
 * its own INVALID_REQUEST naming exactly what is wrong.
 */
export function validateWorkflowSpec(
  spec: WorkflowSpec,
  registry: OperationRegistryEntry[],
  skillsDir: string,
): void {
  const registryById = new Map(registry.map((o) => [o.id, o]));

  const nodeIds = new Set<string>();
  for (const node of spec.nodes) {
    if (nodeIds.has(node.id)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${spec.id}: duplicate node id ${JSON.stringify(node.id)}`,
      );
    }
    nodeIds.add(node.id);
  }
  if (!nodeIds.has(spec.initial)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `workflow ${spec.id}: initial ${JSON.stringify(spec.initial)} is not a node`,
    );
  }
  const terminals = new Set(spec.terminals);
  for (const node of spec.nodes) {
    for (const [edge, target] of [
      ["onSuccess", node.onSuccess],
      ["onFailure", node.onFailure],
    ] as const) {
      if (!nodeIds.has(target) && !terminals.has(target)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `workflow ${spec.id}: node ${node.id}.${edge} targets ${JSON.stringify(target)} which is neither a node nor a declared terminal`,
        );
      }
    }
  }
  // Reachability from initial.
  const edges = new Map(spec.nodes.map((n) => [n.id, [n.onSuccess, n.onFailure]]));
  const seen = new Set<string>();
  const queue = [spec.initial];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of edges.get(id) ?? []) {
      if (nodeIds.has(next)) queue.push(next);
    }
  }
  for (const node of spec.nodes) {
    if (!seen.has(node.id)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${spec.id}: node ${node.id} is unreachable from initial ${spec.initial}`,
      );
    }
    // Registered operation + matching type.
    if (node.operationId === null) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${spec.id}: node ${node.id} has no operationId`,
      );
    }
    const entry = registryById.get(node.operationId);
    if (entry === undefined) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${spec.id}: node ${node.id} uses unregistered operationId ${JSON.stringify(node.operationId)}`,
      );
    }
    if (entry.type !== node.type) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${spec.id}: node ${node.id} type ${node.type} does not match registry type ${entry.type} for ${node.operationId}`,
      );
    }
    // Bindings: `context.<declared field>` only — no JSONPath, no eval.
    for (const [key, value] of Object.entries(node.inputBindings)) {
      if (value === undefined) continue;
      if (!BINDING_PATTERN.test(value)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `workflow ${spec.id}: node ${node.id} binding ${key}=${JSON.stringify(value)} is not a context.<field> selector`,
        );
      }
      const field = value.slice("context.".length);
      if (!WORKFLOW_CONTEXT_FIELDS.has(field)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `workflow ${spec.id}: node ${node.id} binding ${key} references undeclared context field ${JSON.stringify(field)}`,
        );
      }
    }
  }
  for (const skill of spec.requiredSkills) {
    if (!existsSync(join(skillsDir, skill, "SKILL.md"))) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `workflow ${spec.id}: requiredSkills entry ${JSON.stringify(skill)} has no resources/skills/${skill}/SKILL.md`,
      );
    }
  }
}

/** Load + fully validate a workflow definition from `resources/workflows/`. */
export function loadWorkflowDefinition(repoRoot: string, definitionId: string): LoadedWorkflowDef {
  const dir = join(repoRoot, "resources", "workflows");
  const registry = loadOperationRegistry(repoRoot);
  const skillsDir = join(repoRoot, "resources", "skills");
  const validate = validatorFor("WorkflowSpec");

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "operation-registry.json") continue;
    let raw: unknown;
    try {
      raw = loadJson(join(dir, file));
    } catch {
      continue; // a malformed unrelated definition must not block this one
    }
    if ((raw as { id?: unknown }).id !== definitionId) continue;
    if (!validate(raw)) {
      throw new WorkbenchError(
        ERROR_CODES.SCHEMA_VALIDATION_FAILED,
        `workflow definition ${file} failed schema validation: ${formatErrors(validate.errors)}`,
      );
    }
    const spec = raw as WorkflowSpec;
    validateWorkflowSpec(spec, registry, skillsDir);
    const bytes = utf8Bytes(canonicalJson(spec));
    return { spec, hash: sha256Hex(bytes), bytes };
  }
  throw new WorkbenchError(
    ERROR_CODES.NOT_FOUND,
    `no workflow definition with id ${JSON.stringify(definitionId)} under resources/workflows`,
  );
}

/**
 * Load a definition by its pinned hash from CAS — the resume path. The
 * bytes are hash-verified by the blob store; they are re-validated against
 * the schema (not the registry — a running workflow keeps the semantics it
 * started with even if the registry later changes).
 */
export function loadDefinitionFromCas(blobs: BlobStore, definitionHash: string): WorkflowSpec {
  const raw = JSON.parse(new TextDecoder().decode(blobs.getVerified(definitionHash))) as unknown;
  const validate = validatorFor("WorkflowSpec");
  if (!validate(raw)) {
    throw new WorkbenchError(
      ERROR_CODES.SCHEMA_VALIDATION_FAILED,
      `pinned workflow definition ${definitionHash} failed schema validation: ${formatErrors(validate.errors)}`,
    );
  }
  const spec = raw as WorkflowSpec;
  // Structural checks that do not depend on host resources still apply.
  const nodeIds = new Set(spec.nodes.map((n) => n.id));
  if (!nodeIds.has(spec.initial)) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `pinned workflow ${spec.id}: initial ${spec.initial} is not a node`,
    );
  }
  const terminals = new Set(spec.terminals);
  for (const node of spec.nodes) {
    for (const target of [node.onSuccess, node.onFailure]) {
      if (!nodeIds.has(target) && !terminals.has(target)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `pinned workflow ${spec.id}: node ${node.id} has a dangling edge to ${JSON.stringify(target)}`,
        );
      }
    }
  }
  return spec;
}
