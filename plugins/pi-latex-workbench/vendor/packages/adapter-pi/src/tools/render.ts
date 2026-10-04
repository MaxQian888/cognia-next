/**
 * latex_render — LIVE (M4): real PDFKit-backed page rasterization and text
 * extraction against stored pdf artifacts. `pages` publishes deterministic
 * page-image artifacts + a render manifest AND attaches the rendered PNG
 * bytes as Pi image content blocks (page order = data.pages order), capped
 * at IMAGE_BYTE_CAP total; pages past the cap are reported in the envelope's
 * imagesTruncated. `text` extracts per-page text and persists it as a text
 * artifact. An unprovisioned render-helper surfaces as RUNTIME_UNAVAILABLE —
 * never as an empty result.
 */
import type { RenderInput, RenderResult } from "@latexwb/contracts";
import { renderPages, renderText } from "@latexwb/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "../session.ts";
import { RenderParams } from "../schemas.ts";
import {
  jobArtifactRefs,
  runTool,
  toAgentResult,
  type AttachedImage,
  type DispatchOutcome,
} from "./common.ts";

/** Total PNG bytes a single pages call may attach as image blocks. */
export const RENDER_IMAGE_BYTE_CAP = 8 * 1024 * 1024;

/**
 * Pull the rendered page bytes from CAS (digest-verified) in result order.
 * Pages whose artifact row is missing or whose bytes would exceed the cap
 * land in `truncated` — the envelope then says so via imagesTruncated.
 */
function collectPageImages(
  session: WorkbenchSession,
  scope: Scope,
  result: RenderResult,
  byteCap: number,
): { images: AttachedImage[]; truncated: number[] } {
  const images: AttachedImage[] = [];
  const truncated: number[] = [];
  let budget = byteCap;
  for (const page of result.pages) {
    const row = session.store.getArtifact(scope, page.imageArtifactId);
    if (row === null) {
      truncated.push(page.page);
      continue;
    }
    const bytes = session.blobs.getVerified(row["blob_hash"] as string);
    if (bytes.length > budget) {
      truncated.push(page.page);
      continue;
    }
    images.push({ data: bytes, mimeType: row["media_type"] as string });
    budget -= bytes.length;
  }
  return { images, truncated };
}

async function dispatch(
  session: WorkbenchSession,
  input: RenderInput,
  scope: Scope,
  images: AttachedImage[],
  imageByteCap: number,
): Promise<DispatchOutcome> {
  const deps = {
    store: session.store,
    blobs: session.blobs,
    ctx: session.requestContextFor(["data.render", "artifact.read"]),
    scope,
    repoRoot: session.config.repoRoot,
    hostPolicy: session.hostPolicy(),
  };
  switch (input.action) {
    case "pages": {
      const out = await renderPages(deps, {
        artifactId: input.artifactId,
        renderPresetId: input.renderPresetId,
        pages: input.pages,
      });
      const { images: collected, truncated } = collectPageImages(
        session,
        scope,
        out.result,
        imageByteCap,
      );
      images.push(...collected);
      return {
        data:
          truncated.length > 0
            ? { ...out.result, imagesTruncated: truncated }
            : out.result,
        snapshotId: out.result.pdfArtifactId !== null
          ? (session.store.getArtifact(scope, out.result.pdfArtifactId)?.["snapshot_id"] as string)
          : null,
        artifacts: jobArtifactRefs(session.store, scope, out.jobId),
      };
    }
    case "text": {
      const out = await renderText(deps, {
        artifactId: input.artifactId,
        pages: input.pages,
      });
      const row = session.store.getArtifact(scope, input.artifactId);
      return {
        data: out.result,
        snapshotId: (row?.["snapshot_id"] as string | undefined) ?? null,
        artifacts: jobArtifactRefs(session.store, scope, out.jobId),
      };
    }
  }
}

export function renderTool(
  session: WorkbenchSession,
  options?: { imageByteCap?: number },
): ToolDefinition {
  const imageByteCap = options?.imageByteCap ?? RENDER_IMAGE_BYTE_CAP;
  return {
    name: "latex_render",
    label: "LaTeX Render",
    description:
      "Rasterize pages of a compiled pdf artifact to deterministic page-image " +
      "artifacts and return the rendered PNGs as image blocks (action=pages) " +
      "or extract per-page text (action=text). Requires the provisioned " +
      "Swift/PDFKit render-helper (latexwb provision-renderer).",
    promptSnippet: "Render PDF pages to images (visual layout check) or extract per-page text",
    promptGuidelines: ["Use latex_render pages for layout claims; if the returned images are omitted because the model is text-only, say the pages were not visually inspected and fall back to latex_render text."],
    parameters: RenderParams,
    async execute(_toolCallId, params) {
      const images: AttachedImage[] = [];
      const envelope = await runTool(session, "RenderInput", params, (input: RenderInput, scope) =>
        dispatch(session, input, scope, images, imageByteCap),
      );
      return toAgentResult(envelope, images);
    },
  };
}
