/**
 * Runtime validators compiled from the authoritative JSON Schema
 * (packages/contracts/schemas/contracts.schema.json, draft 2020-12).
 * Unknown fields are rejected exactly as the schema declares
 * (additionalProperties: false / oneOf); nothing is relaxed here.
 */
import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction, type ErrorObject } from "ajv/dist/2020.js";
import * as ajvFormats from "ajv-formats";
import { WorkbenchError, ERROR_CODES } from "./errors.ts";

// ajv-formats is CJS: module.exports is the plugin function itself, while its
// .d.ts models `export default` — under NodeNext the namespace `default` is
// typed self-referentially, so bind it through the real runtime shape.
const addFormats = ajvFormats.default as unknown as (instance: Ajv2020) => void;

export const CONTRACTS_SCHEMA_ID = "urn:pi-latex:contracts:1";

const schemaUrl = new URL("../schemas/contracts.schema.json", import.meta.url);

export function loadContractsSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaUrl, "utf8")) as Record<string, unknown>;
}

function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(loadContractsSchema());
  return ajv;
}

const ajv = buildAjv();

/** Names of $defs with precompiled validators exported from this package. */
export const VALIDATED_DEFS = [
  "ToolRequest",
  "ToolEnvelope",
  "ProjectConfig",
  "SnapshotManifest",
  "WorkflowSpec",
  "HostPolicy",
  "ToolchainLock",
  "CapabilityManifest",
  "DomainProfile",
  "OutputProfile",
  "VenueProfile",
  "ReviewRecord",
  "Event",
  "DoctorReport",
  "BuildPreset",
] as const;

export type ValidatedDef = (typeof VALIDATED_DEFS)[number];

export function validatorFor(def: string): ValidateFunction {
  const validator = ajv.getSchema(`${CONTRACTS_SCHEMA_ID}#/$defs/${def}`);
  if (validator === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `contracts schema has no $defs/${def}`,
    );
  }
  return validator;
}

function compile(def: ValidatedDef): ValidateFunction {
  return validatorFor(def);
}

/** Precompiled validators for the M0 contract surface. */
export const validators: Record<ValidatedDef, ValidateFunction> = {
  ToolRequest: compile("ToolRequest"),
  ToolEnvelope: compile("ToolEnvelope"),
  ProjectConfig: compile("ProjectConfig"),
  SnapshotManifest: compile("SnapshotManifest"),
  WorkflowSpec: compile("WorkflowSpec"),
  HostPolicy: compile("HostPolicy"),
  ToolchainLock: compile("ToolchainLock"),
  CapabilityManifest: compile("CapabilityManifest"),
  DomainProfile: compile("DomainProfile"),
  OutputProfile: compile("OutputProfile"),
  VenueProfile: compile("VenueProfile"),
  ReviewRecord: compile("ReviewRecord"),
  Event: compile("Event"),
  DoctorReport: compile("DoctorReport"),
  BuildPreset: compile("BuildPreset"),
};

export function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "no details";
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim())
    .join("; ");
}

/**
 * Validate `data` against $defs/`def`. Returns the data unchanged on success,
 * throws SCHEMA_VALIDATION_FAILED on rejection.
 */
export function assertValid<T>(def: ValidatedDef, data: unknown): T {
  const validator = validators[def];
  if (!validator(data)) {
    throw new WorkbenchError(
      ERROR_CODES.SCHEMA_VALIDATION_FAILED,
      `${def} validation failed: ${formatErrors(validator.errors)}`,
    );
  }
  return data as T;
}
