/**
 * Page rendering + text extraction (M4): durable service jobs that drive the
 * provisioned Swift/PDFKit render-helper. Every page produces a real
 * page-image artifact whose bytes are the deterministic PNG; a manifest
 * artifact records the renderer identity (manifest sha256), page geometry
 * and per-page hashes so reviewers and the release gate can bind reviews to
 * exactly what was observed.
 *
 * Nothing here fabricates output: an unprovisioned helper is
 * RUNTIME_UNAVAILABLE, a malformed PDF is INVALID_ARTIFACT, and a subset
 * `pages` request only narrows which page artifacts are published — the
 * manifest always records the full page set it rendered.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  ERROR_CODES,
  sha256Hex,
  utf8Bytes,
  WorkbenchError,
  type HostPolicy,
  type PageTextResult,
  type RenderResult,
} from "@latexwb/contracts";
import { loadRenderer, renderPdf, type RenderedPdf } from "@latexwb/runtime";
import type { BlobStore, Scope, WorkbenchStore } from "@latexwb/storage";
import { requireCapability } from "./capabilities.ts";
import type { RequestContext } from "./context.ts";
import { requireArtifact, type CollectedArtifact } from "./artifacts.ts";
import { runServiceJob } from "./service-job.ts";
import type { JobService } from "./jobs.ts";

export interface RenderDeps {
  store: WorkbenchStore;
  blobs: BlobStore;
  ctx: RequestContext;
  scope: Scope;
  repoRoot: string;
  jobs?: JobService;
  hostPolicy: HostPolicy | null;
}

/** renderPresetId → raster DPI. screen = 1x (72dpi), detail = 2x (144dpi). */
export const RENDER_PRESET_DPI: Record<string, number> = {
  screen: 72,
  detail: 144,
};

/** PNG IHDR width/height (fixed offsets after the 8-byte signature). */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes);
  if (
    b.length < 24 ||
    b.readUInt32BE(0) !== 0x89504e47 ||
    b.toString("latin1", 12, 16) !== "IHDR"
  ) {
    throw new WorkbenchError(ERROR_CODES.INVALID_ARTIFACT, "page image is not a PNG");
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function pdfBytesToTemp(blobs: BlobStore, blobHash: string, dir: string): string {
  const bytes = blobs.getVerified(blobHash);
  const path = join(dir, "subject.pdf");
  writeFileSync(path, bytes);
  return path;
}

export interface RenderPagesOutput {
  result: RenderResult;
  manifestArtifactId: string;
  pageArtifactIds: string[];
  jobId: string;
  rendererManifestSha256: string;
}

/**
 * `latex_render pages`: rasterize the PDF's pages to deterministic PNG
 * artifacts + a render manifest artifact binding them to the helper sha256.
 */
export async function renderPages(
  deps: RenderDeps,
  input: { artifactId: string; renderPresetId: string; pages?: number[] },
): Promise<RenderPagesOutput> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "data.render");
  const subject = requireArtifact(store, scope, input.artifactId);
  if ((subject["kind"] as string) !== "pdf") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `artifact ${input.artifactId} is ${subject["kind"]}, not a pdf — latex_render only rasterizes pdf artifacts`,
    );
  }
  const dpi = RENDER_PRESET_DPI[input.renderPresetId];
  if (dpi === undefined) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `unknown renderPresetId ${JSON.stringify(input.renderPresetId)} (known: ${Object.keys(RENDER_PRESET_DPI).join(", ")})`,
    );
  }
  const snapshotId = subject["snapshot_id"] as string;
  const targetId = (subject["target_id"] as string | null) ?? null;

  const out = await runServiceJob<Omit<RenderPagesOutput, "jobId">>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "render.pages",
    snapshotId,
    targetId,
    input,
    compute: async (jobId) => {
      const workDir = mkdtempSync(join(tmpdir(), `latexwb-render-${jobId}-`));
      try {
        const pdfPath = pdfBytesToTemp(blobs, subject["blob_hash"] as string, workDir);
        const rendered: RenderedPdf = await renderPdf(
          deps.repoRoot, pdfPath, join(workDir, "out"), "pages", dpi,
          { timeoutMs: (deps.hostPolicy?.limits?.buildTimeoutSeconds ?? 180) * 1000 },
        );
        const renderer = loadRenderer(deps.repoRoot);
        if (renderer === null) {
          // Unreachable — renderPdf already enforced this — kept so the
          // manifest sha we record is the verified one, never a guess.
          throw new WorkbenchError(ERROR_CODES.RUNTIME_UNAVAILABLE, "renderer vanished mid-render");
        }
        const wantedPages =
          input.pages === undefined ? null : new Set(input.pages);

        const artifacts: CollectedArtifact[] = [];
        const pageRefs: RenderResult["pages"] = [];
        const pageArtifactIds: string[] = [];
        const manifestPages: Array<{
          page: number;
          artifactId: string;
          sha256: string;
          widthPx: number;
          heightPx: number;
        }> = [];

        for (const page of rendered.pages) {
          if (wantedPages !== null && !wantedPages.has(page.page)) continue;
          const pngName = `page-${page.page}.png`;
          let pngBytes: Buffer;
          try {
            pngBytes = readFileSync(join(workDir, "out", pngName));
          } catch {
            throw new WorkbenchError(
              ERROR_CODES.INVALID_ARTIFACT,
              `render-helper reported success but wrote no ${pngName}`,
            );
          }
          const dims = pngDimensions(pngBytes);
          const blob = blobs.put(pngBytes);
          const artifactId = `page-image-${blob.hash.slice(0, 16)}`;
          artifacts.push({
            artifactId,
            relPath: pngName,
            kind: "page-image",
            blobHash: blob.hash,
            sizeBytes: pngBytes.length,
            mediaType: "image/png",
            manifestExtra: { page: page.page, pdfArtifactId: input.artifactId },
          });
          pageArtifactIds.push(artifactId);
          pageRefs.push({
            page: page.page,
            imageArtifactId: artifactId,
            widthPx: dims.width,
            heightPx: dims.height,
            renderHash: blob.hash,
          });
          manifestPages.push({
            page: page.page,
            artifactId,
            sha256: blob.hash,
            widthPx: dims.width,
            heightPx: dims.height,
          });
        }

        // The render manifest: binds this pdf to the renderer identity and
        // every page artifact's sha256. Persisted as a 'manifest' artifact
        // (canonical JSON bytes) AND as an evidence record.
        const manifestRecord = {
          schemaVersion: 1,
          kind: "render-manifest",
          pdfArtifactId: input.artifactId,
          pdfSha256: subject["blob_hash"] as string,
          rendererManifestSha256: renderer.manifestSha256,
          helperVersion: renderer.manifest.version,
          dpi,
          pageCount: rendered.pageCount,
          renderedPages: manifestPages.map((p) => p.page),
          pages: manifestPages,
        };
        const manifestBytes = utf8Bytes(canonicalJson(manifestRecord));
        const manifestBlob = blobs.put(manifestBytes);
        const manifestArtifactId = `manifest-${manifestBlob.hash.slice(0, 16)}`;
        artifacts.push({
          artifactId: manifestArtifactId,
          relPath: "render-manifest.json",
          kind: "manifest",
          blobHash: manifestBlob.hash,
          sizeBytes: manifestBytes.length,
          mediaType: "application/json",
          manifestExtra: { pdfArtifactId: input.artifactId, pageCount: rendered.pageCount },
        });

        const result: RenderResult = {
          kind: "render-result",
          pdfArtifactId: input.artifactId,
          renderVersion: `${renderer.manifest.version}+manifest:${renderer.manifestSha256}`,
          pages: pageRefs,
        };
        return {
          result: {
            result,
            manifestArtifactId,
            pageArtifactIds,
            rendererManifestSha256: renderer.manifestSha256,
          } satisfies Omit<RenderPagesOutput, "jobId">,
          artifacts,
          evidence: [
            {
              snapshotId,
              kind: "render-manifest",
              sourceLocator: `artifact:${input.artifactId}`,
              content: manifestBytes,
              accessStatus: "fulltext",
              record: {
                pdfArtifactId: input.artifactId,
                rendererManifestSha256: renderer.manifestSha256,
                pageCount: rendered.pageCount,
                dpi,
              },
            },
          ],
        };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  });
  return { ...out.result, jobId: out.jobId };
}

export interface RenderTextOutput {
  result: PageTextResult;
  manifestArtifactId: string;
  jobId: string;
}

/**
 * `latex_render text`: extract per-page text + write a text artifact of the
 * extraction (the render.json page texts) so the data has a durable id.
 */
export async function renderText(
  deps: RenderDeps,
  input: { artifactId: string; pages?: number[] },
): Promise<RenderTextOutput> {
  const { store, blobs, ctx, scope } = deps;
  requireCapability(ctx, "data.render");
  const subject = requireArtifact(store, scope, input.artifactId);
  if ((subject["kind"] as string) !== "pdf") {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `artifact ${input.artifactId} is ${subject["kind"]}, not a pdf`,
    );
  }
  const snapshotId = subject["snapshot_id"] as string;
  const targetId = (subject["target_id"] as string | null) ?? null;

  const out = await runServiceJob<Omit<RenderTextOutput, "jobId">>({
    store,
    blobs,
    ctx,
    scope,
    jobs: deps.jobs,
    action: "render.text",
    snapshotId,
    targetId,
    input,
    compute: async (jobId) => {
      const workDir = mkdtempSync(join(tmpdir(), `latexwb-render-${jobId}-`));
      try {
        const pdfPath = pdfBytesToTemp(blobs, subject["blob_hash"] as string, workDir);
        const rendered = await renderPdf(
          deps.repoRoot, pdfPath, join(workDir, "out"), "json", 72,
          { timeoutMs: (deps.hostPolicy?.limits?.buildTimeoutSeconds ?? 180) * 1000 },
        );
        const wantedPages = input.pages === undefined ? null : new Set(input.pages);
        const pages = rendered.pages
          .filter((p) => wantedPages === null || wantedPages.has(p.page))
          .map((p) => ({
            page: p.page,
            text: p.text,
            coverage: (p.text.trim().length > 0 ? "full" : "none") as "full" | "none",
          }));
        const result: PageTextResult = {
          kind: "page-text",
          pdfArtifactId: input.artifactId,
          pages,
        };
        const bytes = utf8Bytes(canonicalJson(result));
        const blob = blobs.put(bytes);
        const manifestArtifactId = `text-${blob.hash.slice(0, 16)}`;
        return {
          result: { result, manifestArtifactId } satisfies Omit<RenderTextOutput, "jobId">,
          artifacts: [
            {
              artifactId: manifestArtifactId,
              relPath: "page-text.json",
              kind: "text",
              blobHash: blob.hash,
              sizeBytes: bytes.length,
              mediaType: "application/json",
            } satisfies CollectedArtifact,
          ],
          evidence: [
            {
              snapshotId,
              kind: "page-text",
              sourceLocator: `artifact:${input.artifactId}`,
              content: bytes,
              accessStatus: "fulltext",
              record: {
                pdfArtifactId: input.artifactId,
                pageCount: rendered.pageCount,
                pages: pages.map((p) => ({ page: p.page, coverage: p.coverage })),
              },
            },
          ],
        };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  });
  return { ...out.result, jobId: out.jobId };
}
