/**
 * TypeBox parameter schemas for the eight latex_* tools.
 *
 * These are LLM-facing hints ONLY. The frozen JSON-Schema validators in
 * @latexwb/contracts are the sole authority; every tool re-validates raw
 * params inside execute() before any service call. The parity corpus test
 * (test/m2c.parity.test.ts) asserts identical accept/reject decisions for a
 * corpus of valid and invalid inputs — a divergence is a test failure.
 */
import { Type, type TSchema } from "typebox";

/** Providers require a top-level `type: "object"`; Type.Union emits a bare
 * `anyOf`, so stamp the type onto the union object. */
function objectUnion(members: TSchema[]): TSchema {
  return Object.assign(Type.Union(members), { type: "object" });
}

const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:-]*$";
const REL_PATH_PATTERN =
  "^(?![A-Za-z]:)(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)(?!.*[\\x00-\\x1f\\x7f]).+$";

const Id = Type.String({ minLength: 1, maxLength: 160, pattern: ID_PATTERN });
const RelPath = Type.String({ minLength: 1, maxLength: 1024, pattern: REL_PATH_PATTERN });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

const projectId = { projectId: Id };

function obj(props: Record<string, TSchema>, extra: Record<string, unknown> = {}) {
  return Type.Object(props, { additionalProperties: false, ...extra });
}

// ---------------------------------------------------------------------------
// latex_project — ProjectInput
// ---------------------------------------------------------------------------

export const ProjectParams = objectUnion(
  [
    obj({ action: Type.Literal("inspect"), ...projectId, targetId: Type.Optional(Id) }),
    obj({ action: Type.Literal("init"), ...projectId, templateId: Id, targetId: Id }),
    obj({ action: Type.Literal("snapshot"), ...projectId, expectedHeadSnapshotId: Id }),
    obj({
      action: Type.Literal("read"),
      ...projectId,
      snapshotId: Id,
      path: RelPath,
      startLine: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
      maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
    }),
    obj({
      action: Type.Literal("search"),
      ...projectId,
      snapshotId: Id,
      query: Type.String({ minLength: 1, maxLength: 1000 }),
      pathPrefix: Type.Optional(RelPath),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
    }),
    obj({
      action: Type.Literal("artifact-read"),
      ...projectId,
      artifactId: Id,
      startLine: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
      maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
    }),
    obj({ action: Type.Literal("resource"), ...projectId, resourceId: Id }),
    obj({ action: Type.Literal("doctor"), ...projectId, targetId: Type.Optional(Id) }),
  ],
);

// ---------------------------------------------------------------------------
// latex_patch — PatchInput (propose/apply/revert only; approve is host-side)
// ---------------------------------------------------------------------------

const TextEdit = obj({
  startByte: Type.Integer({ minimum: 0 }),
  endByte: Type.Integer({ minimum: 0 }),
  replacement: Type.String({ maxLength: 524288 }),
});

const TextReplace = obj({
  oldText: Type.String({
    minLength: 1,
    maxLength: 524288,
    description: "Exact text currently in the file (copy from latex_project read, including line breaks). Must occur exactly once unless occurrence is set.",
  }),
  newText: Type.String({ maxLength: 524288, description: "Replacement text; empty string deletes oldText." }),
  occurrence: Type.Optional(Type.Integer({ minimum: 1, description: "1-based match to replace when oldText occurs more than once." })),
});

const FileOperation = objectUnion(
  [
    obj({
      op: Type.Literal("replace"),
      path: RelPath,
      expectedSha256: Type.Optional(Sha256),
      edits: Type.Array(TextReplace, { minItems: 1, maxItems: 200 }),
    }),
    obj({
      op: Type.Literal("attach-asset"),
      path: RelPath,
      artifactId: Id,
      expectedSha256: Type.Union([Sha256, Type.Null()]),
    }),
    obj({
      op: Type.Literal("edit"),
      path: RelPath,
      expectedSha256: Sha256,
      edits: Type.Array(TextEdit, { minItems: 1, maxItems: 200 }),
    }),
    obj({ op: Type.Literal("create"), path: RelPath, content: Type.String({ maxLength: 524288 }) }),
    obj({ op: Type.Literal("delete"), path: RelPath, expectedSha256: Sha256 }),
  ],
);

export const PatchParams = objectUnion(
  [
    obj({
      action: Type.Literal("propose"),
      ...projectId,
      baseSnapshotId: Id,
      operations: Type.Array(FileOperation, { minItems: 1, maxItems: 50 }),
      reason: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    obj({ action: Type.Literal("apply"), ...projectId, patchId: Id }),
    obj({
      action: Type.Literal("revert"),
      ...projectId,
      patchId: Id,
      baseSnapshotId: Id,
      reason: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
  ],
);

// ---------------------------------------------------------------------------
// latex_build — BuildInput
// ---------------------------------------------------------------------------

export const BuildParams = objectUnion(
  [
    obj({
      action: Type.Literal("run"),
      ...projectId,
      snapshotId: Id,
      targetId: Type.String({ ...Id, description: "Registered target ID, or 'default' to auto-resolve an imported project's root. Not a filename." }),
      clean: Type.Optional(Type.Boolean({ default: false })),
    }),
    obj({ action: Type.Literal("status"), ...projectId, jobId: Id }),
    obj({ action: Type.Literal("cancel"), ...projectId, jobId: Id }),
  ],
);

// ---------------------------------------------------------------------------
// latex_check — CheckInput (rulesets: draft, release, data-assets)
// ---------------------------------------------------------------------------

export const CheckParams = objectUnion(
  [
    obj({
      action: Type.Literal("run"),
      ...projectId,
      artifactId: Id,
      rulesetId: Id,
      baselineArtifactId: Type.Optional(Id),
    }),
    obj({ action: Type.Literal("report"), ...projectId, reportArtifactId: Id }),
  ],
);

// ---------------------------------------------------------------------------
// latex_render — RenderInput (provisioned Swift/PDFKit render helper)
// ---------------------------------------------------------------------------

const PageList = Type.Array(Type.Integer({ minimum: 1 }), {
  minItems: 1,
  maxItems: 1000,
  uniqueItems: true,
});

export const RenderParams = objectUnion(
  [
    obj({
      action: Type.Literal("pages"),
      ...projectId,
      artifactId: Id,
      pages: PageList,
      renderPresetId: Type.Union([Type.Literal("screen"), Type.Literal("detail")]),
    }),
    obj({ action: Type.Literal("text"), ...projectId, artifactId: Id, pages: PageList }),
  ],
);

// ---------------------------------------------------------------------------
// latex_bib — BibInput
// ---------------------------------------------------------------------------

export const BibParams = objectUnion(
  [
    obj({
      action: Type.Literal("lookup"),
      ...projectId,
      query: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    obj({
      action: Type.Literal("lookup"),
      ...projectId,
      identifier: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    obj({
      action: Type.Literal("audit"),
      ...projectId,
      snapshotId: Id,
      bibPaths: Type.Array(RelPath, { minItems: 1, maxItems: 100 }),
    }),
    obj({
      action: Type.Literal("propose-import"),
      ...projectId,
      baseSnapshotId: Id,
      bibPath: RelPath,
      candidateIds: Type.Array(Id, { minItems: 1, maxItems: 100 }),
    }),
  ],
);

// ---------------------------------------------------------------------------
// latex_figure — FigureInput
// ---------------------------------------------------------------------------

const DiagramSpec = obj({
  kind: Type.Union([Type.Literal("concept-flow"), Type.Literal("tree"), Type.Literal("circuit-block")]),
  nodes: Type.Array(
    obj({
      id: Id,
      label: Type.String({ maxLength: 200 }),
      role: Type.Union([
        Type.Literal("process"),
        Type.Literal("input"),
        Type.Literal("output"),
        Type.Literal("decision"),
        Type.Literal("group"),
      ]),
    }),
    { minItems: 1, maxItems: 100 },
  ),
  edges: Type.Array(
    obj({ from: Id, to: Id, label: Type.String({ maxLength: 200 }) }),
    { maxItems: 300 },
  ),
  caption: Type.String({ maxLength: 4000 }),
  stylePresetId: Id,
});

const TableSpec = obj({
  columns: Type.Array(
    obj({
      field: Type.String({ minLength: 1 }),
      label: Type.String(),
      unit: Type.Union([Type.String(), Type.Null()]),
      decimalPlaces: Type.Union([Type.Integer({ minimum: 0, maximum: 12 }), Type.Null()]),
    }),
    { minItems: 1, maxItems: 40 },
  ),
  roundingMode: Type.Union([Type.Literal("half-even"), Type.Literal("half-up")]),
  missingValue: Type.String({ maxLength: 20 }),
  caption: Type.String({ maxLength: 4000 }),
  label: Type.String({ minLength: 1, maxLength: 128 }),
});

const PlotParams = obj({
  xField: Type.String({ minLength: 1 }),
  yFields: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
  errorField: Type.Union([Type.String(), Type.Null()]),
  xLabel: Type.String(),
  yLabel: Type.String(),
  title: Type.String(),
  widthMm: Type.Number({ minimum: 40, maximum: 500 }),
  heightMm: Type.Number({ minimum: 30, maximum: 500 }),
});

export const FigureParams = objectUnion(
  [
    obj({ action: Type.Literal("diagram"), ...projectId, snapshotId: Id, sourceAssetId: Id, recipeId: Id, diagramSpec: DiagramSpec }),
    obj({ action: Type.Literal("table"), ...projectId, snapshotId: Id, sourceAssetId: Id, tableSpec: TableSpec }),
    obj({ action: Type.Literal("plot"), ...projectId, snapshotId: Id, sourceAssetId: Id, recipeId: Id, params: PlotParams }),
  ],
);

// ---------------------------------------------------------------------------
// latex_export — ExportInput (release pipeline)
// ---------------------------------------------------------------------------

const ReleaseProfile = Type.Union([
  Type.Literal("draft"),
  Type.Literal("review"),
  Type.Literal("submission"),
]);

export const ExportParams = objectUnion(
  [
    obj({ action: Type.Literal("prepare"), ...projectId, snapshotId: Id, targetId: Id, releaseProfileId: ReleaseProfile }),
    obj({ action: Type.Literal("package"), ...projectId, snapshotId: Id, targetId: Id, releaseProfileId: ReleaseProfile, releaseId: Type.Optional(Id) }),
  ],
);
