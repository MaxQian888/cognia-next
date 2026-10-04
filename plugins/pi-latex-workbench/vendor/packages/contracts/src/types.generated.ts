/** Generated from packages/contracts/schemas/contracts.schema.json.
 * Do not edit by hand. Regenerate with: npm run contracts:types
 * Declarations only; runtime validation lives in validators.ts and
 * semantic checks live in the service layer.
 */
export type Target = { "id": string; "root": string; "workingDirectory": "project-root" | "entry-parent"; "engine": "pdflatex" | "xelatex" | "lualatex"; "bibliography": "none" | "bibtex" | "biber" | "provided-bbl"; "outputProfileId": "article" | "zh-thesis" | "beamer" | "poster" | "book-report" | "exam-student" | "exam-teacher" | "cv-letter"; "venueProfileId": (string | null); "buildPresetId": string; };

export type ProjectConfig = { "schemaVersion": 1; "projectId": string; "languages": Array<string>; "domains": Array<"mathematics" | "cs-ml" | "cs-systems" | "statistics-economics" | "physics-astronomy" | "chemistry-materials" | "electrical-control" | "biology-biomed" | "psychology-social" | "humanities-linguistics">; "targets": Array<Target>; "protectedContent": { "math": boolean; "citationKeys": boolean; "labels": boolean; "reportedResults": boolean; "quotes": boolean; "templateFiles": boolean; "rawAssets": boolean; }; "resources": { "include": Array<string>; "exclude": Array<string>; }; "qualityProfile": "draft" | "review" | "submission"; };

export type SnapshotFile = { "path": string; "sha256": string; "bytes": number; "role": "source" | "bibliography" | "provided-bbl" | "raw-asset" | "generated-asset" | "template" | "project-config"; "executable": false; };

export type SnapshotManifest = { "schemaVersion": 1; "id": string; "workspaceId": string; "projectId": string; "parentSnapshotId": (string | null); "treeHash": string; "createdAt": string; "files": Array<SnapshotFile>; };

export type SourceLocation = { "path": string; "line": (number | null); "column": (number | null); };

export type Diagnostic = { "code": string; "severity": "info" | "warning" | "error"; "message": string; "source": (SourceLocation | null); "page": (number | null); "causeId": (string | null); "evidenceArtifactIds": Array<string>; "rawLogRange": ({ "startLine": number; "endLine": number; } | null); "confidence": "certain" | "heuristic" | "unknown"; };

export type ArtifactRef = { "id": string; "projectId": string; "snapshotId": string; "targetId": (string | null); "jobId": string; "kind": "pdf" | "source-zip" | "log" | "report" | "page-image" | "source-diff" | "manifest" | "data-table" | "vector-figure" | "text"; "sha256": string; "bytes": number; "mediaType": string; "createdAt": string; };

export type ToolError = { "code": string; "message": string; "retryable": boolean; };

export type JobRef = { "kind": "job"; "jobId": string; "snapshotId": (string | null); "state": "queued" | "running" | "cancel-requested" | "succeeded" | "failed" | "cancelled" | "timed-out" | "lost"; "attempt": number; "reusedFromJobId": (string | null); };

export type BuildResult = { "kind": "build-result"; "jobId": string; "snapshotId": string; "targetId": string; "toolchainDigest": string; "status": "compiled" | "compile-failed" | "dependency-blocked" | "invalid-artifact"; "exitCode": (number | null); "durationMs": number; "cacheHit": boolean; "reusedFromJobId": (string | null); "pdfArtifactId": (string | null); "logArtifactId": string; "dependencyManifestId": (string | null); "diagnostics": Array<Diagnostic>; };

export type CheckResult = { "checkId": string; "checkVersion": string; "inputDigest": string; "status": "pass" | "fail" | "not-applicable" | "unsupported" | "needs-review"; "severity": "info" | "warning" | "error"; "scope": { "paths": Array<string>; "pages": Array<number>; "anchorIds": Array<string>; }; "findings": Array<string>; "evidenceArtifactIds": Array<string>; "reviewerKind": "deterministic" | "model" | "human" | "not-run"; "checkedAt": string; };

export type CheckReport = { "kind": "check-report"; "reportId": string; "artifactId": string; "snapshotId": string; "requiredCheckIds": Array<string>; "results": Array<CheckResult>; "coverage": { "pagesTotal": number; "pagesReviewed": Array<number>; "trackedValues": number; "candidateValues": number; }; "blockingIds": Array<string>; "missingReviewIds": Array<string>; "inputDigest": string; };

export type ProtectedChange = { "path": string; "category": "math" | "citation-key" | "label" | "reported-result" | "quote" | "template" | "raw-asset" | "unknown-macro"; "change"?: "added" | "modified" | "removed"; "before": string; "after": string; "reason": string; };

export type TextEdit = { "startByte": number; "endByte": number; "replacement": string; };

export type TextReplace = { "oldText": string; "newText": string; "occurrence"?: number; };

export type FileOperation = ({ "op": "attach-asset"; "path": string; "artifactId": string; "expectedSha256": (string | null); } | { "op": "edit"; "path": string; "expectedSha256": string; "edits": Array<TextEdit>; } | { "op": "replace"; "path": string; "expectedSha256"?: string; "edits": Array<TextReplace>; } | { "op": "create"; "path": string; "content": string; } | { "op": "delete"; "path": string; "expectedSha256": string; });

export type PatchProposal = { "kind": "patch-proposal"; "patchId": string; "baseSnapshotId": string; "digest": string; "changedPaths": Array<string>; "diffArtifactId": string; "protectedChanges": Array<ProtectedChange>; "risk": "normal" | "review-required"; "requiredApprovals": Array<string>; };

export type PatchApplicationResult = { "kind": "patch-applied"; "patchId": string; "previousSnapshotId": string; "snapshotId": string; "treeHash": string; "materialization": "not-requested" | "pending" | "completed" | "conflict"; };

export type SnapshotRef = { "kind": "snapshot"; "snapshotId": string; "treeHash": string; "parentSnapshotId": (string | null); "filesCount": number; };

export type SourceReadResult = { "kind": "source-read"; "snapshotId": string; "path": string; "sha256": string; "startLine": number; "endLine": number; "totalLines": number; "text": string; "lineByteOffsets": Array<number>; "nextStartLine": (number | null); "truncated": boolean; };

export type SourceSearchResult = { "kind": "source-search"; "snapshotId": string; "matches": Array<{ "path": string; "sha256": string; "line": number; "byteOffset": number; "text": string; }>; "truncated": boolean; };

export type ArtifactReadResult = { "kind": "artifact-read"; "artifactId": string; "sha256": string; "startLine": number; "endLine": number; "totalLines": number; "text": string; "lineByteOffsets": Array<number>; "nextStartLine": (number | null); "truncated": boolean; };

export type ResourceResult = { "kind": "resource"; "resourceId": string; "origin": "approved-registry"; "sha256": string; "content": string; "relatedResourceIds": Array<string>; };

export type ProjectInspection = { "kind": "inspection"; "projectId": string; "sourceManifestArtifactId": (string | null); "bibliographyPaths": Array<string>; "assets": Array<{ "id": string; "path": string; "snapshotId": string; "sha256": string; "bytes": number; "mediaType": string; "role": "raw-asset" | "generated-asset"; "sourceLocator": string; }>; "headSnapshotId": (string | null); "targets": Array<Target>; "rootCandidates": Array<{ "path": string; "reason": string; "confidence": "explicit" | "inferred" | "ambiguous"; }>; "languages": Array<string>; "packages": Array<string>; "fonts": Array<string>; "dynamicDependencies": boolean; "untrustedConfigFiles": Array<string>; "diagnostics": Array<Diagnostic>; };

export type DoctorReport = { "kind": "doctor"; "mode": "trusted-local" | "isolated-sdk"; "piPackageName": (string | null); "piVersion": (string | null); "adapterVersion": string; "toolchainDigest": (string | null); "capabilities": Array<{ "name": string; "available": boolean; "detail": string; }>; "blockingCodes": Array<string>; "diagnostics": Array<Diagnostic>; };

export type CitationCandidate = { "id": string; "identifier": (string | null); "title": string; "authors": Array<string>; "year": (number | null); "provider": string; "retrievedAt": string; "metadataHash": string; "metadataStatus": "verified" | "conflict" | "not-found" | "unavailable" | "unverified"; "sourceAccess": "fulltext" | "abstract-only" | "metadata-only" | "none"; "sourceLocator": string; "version": (string | null); };

export type CitationLookupResult = { "kind": "citation-lookup"; "candidates": Array<CitationCandidate>; "warnings": Array<string>; };

export type CitationAudit = { "kind": "citation-audit"; "snapshotId": string; "entries": Array<{ "citekey": string; "syntax": "valid" | "invalid"; "metadata": "verified" | "conflict" | "not-found" | "unavailable" | "unverified"; "versionState": "preprint" | "published" | "unknown"; "sourceAccess": "fulltext" | "abstract-only" | "metadata-only" | "none"; "claimSupport": "supported" | "contradicted" | "insufficient" | "not-reviewed"; "evidenceArtifactIds": Array<string>; }>; "proposedPatchId": (string | null); };

export type TableSpec = { "columns": Array<{ "field": string; "label": string; "unit": (string | null); "decimalPlaces": (number | null); }>; "roundingMode": "half-even" | "half-up"; "missingValue": string; "caption": string; "label": string; };

export type PlotParams = { "xField": string; "yFields": Array<string>; "errorField": (string | null); "xLabel": string; "yLabel": string; "title": string; "widthMm": number; "heightMm": number; };

export type DiagramSpec = { "kind": "concept-flow" | "tree" | "circuit-block"; "nodes": Array<{ "id": string; "label": string; "role": "process" | "input" | "output" | "decision" | "group"; }>; "edges": Array<{ "from": string; "to": string; "label": string; }>; "caption": string; "stylePresetId": string; };

export type GeneratedAssetResult = { "kind": "generated-asset"; "artifactId": string; "sourceAssetId": string; "dataHash": string; "recipeHash": string; "parametersHash": string; "rendererVersion": string; "sourceLocator": string; "numericMappingArtifactId": (string | null); "kindOfContent": "data-table" | "data-plot" | "conceptual"; };

export type RenderResult = { "kind": "render-result"; "pdfArtifactId": string; "renderVersion": string; "pages": Array<{ "page": number; "imageArtifactId": string; "widthPx": number; "heightPx": number; "renderHash": string; }>; "imagesTruncated"?: Array<number>; };

export type PageTextResult = { "kind": "page-text"; "pdfArtifactId": string; "pages": Array<{ "page": number; "text": string; "coverage": "full" | "partial" | "none"; }>; };

export type ReleasePlan = { "kind": "release-plan"; "snapshotId": string; "targetId": string; "candidatePaths": Array<string>; "requiredCheckIds": Array<string>; "requiredApprovals": Array<string>; "blockingCodes": Array<string>; };

export type ReleaseResult = { "kind": "release-result"; "releaseId": string; "snapshotId": string; "targetId": string; "status": "draft" | "review-ready" | "submission-ready" | "blocked"; "pdfArtifactId": (string | null); "sourceZipArtifactId": (string | null); "reportArtifactIds": Array<string>; "rebuildJobId": (string | null); "blockingCodes": Array<string>; };

export type JobResult = { "kind": "job-status"; "jobId": string; "state": "queued" | "running" | "cancel-requested" | "succeeded" | "failed" | "cancelled" | "timed-out" | "lost"; "snapshotId": (string | null); "attempt": number; "resultArtifactIds": Array<string>; "error": (ToolError | null); "buildResult": (BuildResult | null); };

export type ToolData = (JobRef | BuildResult | CheckReport | PatchProposal | PatchApplicationResult | SnapshotRef | SourceReadResult | SourceSearchResult | ArtifactReadResult | ResourceResult | ProjectInspection | DoctorReport | CitationLookupResult | CitationAudit | GeneratedAssetResult | RenderResult | PageTextResult | ReleasePlan | ReleaseResult | JobResult);

export type ToolEnvelope = { "schemaVersion": 1; "requestId": string; "projectId": string; "snapshotId": (string | null); "execution": "completed" | "accepted" | "blocked" | "failed"; "data": (ToolData | null); "error": (ToolError | null); "diagnostics": Array<Diagnostic>; "artifacts": Array<ArtifactRef>; };

export type ProjectInput = ({ "action": "inspect"; "projectId": string; "targetId"?: string; } | { "action": "init"; "projectId": string; "templateId": string; "targetId": string; } | { "action": "snapshot"; "projectId": string; "expectedHeadSnapshotId": string; } | { "action": "read"; "projectId": string; "snapshotId": string; "path": string; "startLine"?: number; "maxLines"?: number; } | { "action": "search"; "projectId": string; "snapshotId": string; "query": string; "pathPrefix"?: string; "maxResults"?: number; } | { "action": "artifact-read"; "projectId": string; "artifactId": string; "startLine"?: number; "maxLines"?: number; } | { "action": "resource"; "projectId": string; "resourceId": string; } | { "action": "doctor"; "projectId": string; "targetId"?: string; });

export type PatchInput = ({ "action": "propose"; "projectId": string; "baseSnapshotId": string; "operations": Array<FileOperation>; "reason": string; } | { "action": "apply"; "projectId": string; "patchId": string; } | { "action": "revert"; "projectId": string; "patchId": string; "baseSnapshotId": string; "reason": string; });

export type BuildInput = ({ "action": "run"; "projectId": string; "snapshotId": string; "targetId": string; "clean"?: boolean; } | { "action": "status"; "projectId": string; "jobId": string; } | { "action": "cancel"; "projectId": string; "jobId": string; });

export type CheckInput = ({ "action": "run"; "projectId": string; "artifactId": string; "rulesetId": string; "baselineArtifactId"?: string; } | { "action": "report"; "projectId": string; "reportArtifactId": string; });

export type RenderInput = ({ "action": "pages"; "projectId": string; "artifactId": string; "pages": Array<number>; "renderPresetId": "screen" | "detail"; } | { "action": "text"; "projectId": string; "artifactId": string; "pages": Array<number>; });

export type BibInput = ({ "action": "lookup"; "projectId": string; "query": string; } | { "action": "lookup"; "projectId": string; "identifier": string; } | { "action": "audit"; "projectId": string; "snapshotId": string; "bibPaths": Array<string>; } | { "action": "propose-import"; "projectId": string; "baseSnapshotId": string; "bibPath": string; "candidateIds": Array<string>; });

export type FigureInput = ({ "action": "diagram"; "projectId": string; "snapshotId": string; "sourceAssetId": string; "recipeId": string; "diagramSpec": DiagramSpec; } | { "action": "table"; "projectId": string; "snapshotId": string; "sourceAssetId": string; "tableSpec": TableSpec; } | { "action": "plot"; "projectId": string; "snapshotId": string; "sourceAssetId": string; "recipeId": string; "params": PlotParams; });

export type ExportInput = ({ "action": "prepare"; "projectId": string; "snapshotId": string; "targetId": string; "releaseProfileId": "draft" | "review" | "submission"; } | { "action": "package"; "projectId": string; "snapshotId": string; "targetId": string; "releaseProfileId": "draft" | "review" | "submission"; "releaseId"?: string; });

export type ToolRequest = ({ "tool": "latex_project"; "parameters": ProjectInput; } | { "tool": "latex_patch"; "parameters": PatchInput; } | { "tool": "latex_build"; "parameters": BuildInput; } | { "tool": "latex_check"; "parameters": CheckInput; } | { "tool": "latex_render"; "parameters": RenderInput; } | { "tool": "latex_bib"; "parameters": BibInput; } | { "tool": "latex_figure"; "parameters": FigureInput; } | { "tool": "latex_export"; "parameters": ExportInput; });

export type DomainRule = { "id": string; "title": string; "mode": "deterministic" | "manual" | "assisted"; "severity": "info" | "warning" | "error"; "requirement": string; "checkImplementation": (string | null); "sourceIds": Array<string>; "testIds": Array<string>; };

export type DomainProfile = { "schemaVersion": 1; "id": "mathematics" | "cs-ml" | "cs-systems" | "statistics-economics" | "physics-astronomy" | "chemistry-materials" | "electrical-control" | "biology-biomed" | "psychology-social" | "humanities-linguistics"; "status": "design-unverified"; "title": string; "packageHints": Array<string>; "referenceResourceId": string; "rules": Array<DomainRule>; "forbiddenActions": Array<string>; "testIds": Array<string>; };

export type OutputProfile = { "schemaVersion": 1; "id": "article" | "zh-thesis" | "beamer" | "poster" | "book-report" | "exam-student" | "exam-teacher" | "cv-letter"; "status": "design-unverified"; "title": string; "requiredSections": Array<string>; "requiredCheckIds": Array<string>; "humanReview": Array<string>; "notes": Array<string>; };

export type WorkflowNode = { "id": string; "type": "operation" | "agent" | "gate" | "switch"; "operationId": (string | null); "inputBindings": { "snapshot"?: string; "target"?: string; "artifact"?: string; }; "onSuccess": string; "onFailure": string; "description": string; };

export type WorkflowSpec = { "schemaVersion": 1; "id": string; "version": 1; "initial": string; "terminals": Array<string>; "maxPatchApplications": number; "maxSameCauseAttempts": number; "nodes": Array<WorkflowNode>; "requiredSkills": Array<string>; };

export type CapabilityManifest = { "schemaVersion": 1; "skillId": string; "workflowIds": Array<string>; "toolNames": Array<"latex_project" | "latex_patch" | "latex_build" | "latex_check" | "latex_render" | "latex_bib" | "latex_figure" | "latex_export">; "resourceIds": Array<string>; "hostCapabilities": Array<string>; "requiresHumanGateFor": Array<string>; };

export type ReviewRecord = { "id": string; "projectId": string; "snapshotId": string; "artifactId": string; "artifactHash": string; "renderHashes": Array<string>; "pages": Array<number>; "checkIds": Array<string>; "reviewerKind": "model" | "human"; "reviewerIdentity": string; "result": "pass" | "fail" | "needs-review"; "findings": Array<string>; "createdAt": string; "inputDigest": string; };

export type Event = ({ "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "job.queued"; "timestamp": string; "payload": { "state": "queued"; }; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "job.started"; "timestamp": string; "payload": { "state": "running"; "workerId": string; }; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "job.progress"; "timestamp": string; "payload": { "stage": string; "message": string; "completedUnits": number; "totalUnits": (number | null); }; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "job.diagnostic"; "timestamp": string; "payload": Diagnostic; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "artifact.created"; "timestamp": string; "payload": ArtifactRef; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "job.finished"; "timestamp": string; "payload": JobResult; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "workflow.waiting"; "timestamp": string; "payload": { "workflowId": string; "reason": string; "state": "waiting-input" | "waiting-approval"; }; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "review.required"; "timestamp": string; "payload": { "artifactId": string; "checkIds": Array<string>; "pages": Array<number>; }; } | { "schemaVersion": 1; "seq": number; "projectId": string; "jobId": (string | null); "snapshotId": (string | null); "attempt": (number | null); "fencingToken": (number | null); "type": "project.head-changed"; "timestamp": string; "payload": { "previousSnapshotId": (string | null); "snapshotId": string; }; });

export type VenueRequirement = { "id": string; "title": string; "severity": "warning" | "error"; "mode": "automatic" | "manual"; "checkImplementation": (string | null); "scope": "main-text" | "references" | "appendix" | "supplement" | "entire-pdf" | "source-package" | "metadata"; "requirement": string; "sourceId": string; "sourceLocator": string; "parameters": { "maxPages": (number | null); "includeReferences": (boolean | null); "includeAppendix": (boolean | null); }; "testIds": Array<string>; };

export type VenueProfile = { "schemaVersion": 1; "id": string; "status": "draft" | "verified" | "expired"; "venue": string; "year": (number | null); "track": (string | null); "stage": "submission" | "revision" | "camera-ready" | "institutional"; "checkedAt": (string | null); "validUntil": (string | null); "sources": Array<{ "id": string; "url": string; "retrievedAt": string; "contentHash": string; "locator": string; }>; "template": { "origin": "official" | "community" | "internal"; "templateId": string; "version": (string | null); "sha256": (string | null); "licenseStatus": "approved" | "permission-required" | "unknown"; }; "requirements": Array<VenueRequirement>; };

export type ToolchainLock = { "schemaVersion": 1; "status": "unresolved-example" | "resolved"; "toolchainDigest": (string | null); "piPackageName": (string | null); "piVersion": (string | null); "fonts": Array<{ "id": string; "sha256": string; }>; "templates": Array<{ "id": string; "sha256": string; }>; "profiles": Array<{ "id": string; "sha256": string; }>; "note": string; };

export type HostPolicy = { "schemaVersion": 1; "mode": "trusted-local" | "isolated-sdk"; "approvedImages": Array<string>; "network": { "compiler": "deny"; "metadataProviders": Array<string>; "venueVerification"?: boolean; "allowPrivateAddresses": false; "fakeIpCidrs"?: Array<string>; }; "limits": { "buildTimeoutSeconds": number; "cpu": number; "memoryMiB": number; "pids": number; "tempSpaceMiB": number; "logMiB": number; "unpackedInputMiB": number; "inputFiles": number; }; "projectConfigCanElevatePermissions": false; "allowProjectRc": false; "allowArbitraryRecipes": false; "requireAllReleasePagesReviewed": true; "protection"?: { "mode": "strict" | "authoring"; }; "note": string; };

export type BuildPreset = { "schemaVersion": 1; "id": string; "runnerId": string; "engine": "pdflatex" | "xelatex" | "lualatex"; "bibliographyMode": "none" | "bibtex" | "biber" | "provided-bbl"; "argvTemplate": Array<string>; "envAllowlist": Array<string>; "limits": { "wallClockMs": number; "cpu": (number | null); "memoryMiB": (number | null); "pids": (number | null); "tmpBytes": (number | null); "maxLogBytes": number; "maxOutputBytes": number; }; };

