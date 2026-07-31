// Storybook-only fixtures for the artifacts subsystem (`components/artifacts/**`).
// Mirrors the inline builders in artifact-preview.stories.tsx, factored out so
// the card / list / renderer / review / panel stories share one source of truth.
// Dependency-free (types only) so importing it never drags the artifact store.
import type {
  Artifact,
  ArtifactLanguage,
  ArtifactType,
  ArtifactVersion,
  CanvasPendingReview,
  CanvasReviewItem,
  JupyterNotebook,
} from "@/types"

/** Fixed timestamp so "x minutes ago" labels render deterministically-ish. */
export const ARTIFACT_STAMP = new Date(1_700_000_000_000)

export function makeArtifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_1",
    sessionId: "ses_1",
    messageId: "msg_1",
    type: "code",
    title: "rate-limiter.ts",
    content:
      "export function rateLimit(max: number, windowMs: number) {\n" +
      "  const hits: number[] = []\n" +
      "  return () => {\n" +
      "    const now = Date.now()\n" +
      "    while (hits.length && now - hits[0] > windowMs) hits.shift()\n" +
      "    if (hits.length >= max) return false\n" +
      "    hits.push(now)\n" +
      "    return true\n" +
      "  }\n" +
      "}\n",
    language: "typescript",
    version: 3,
    createdAt: ARTIFACT_STAMP,
    updatedAt: ARTIFACT_STAMP,
    metadata: { runnable: true },
    ...over,
  }
}

/** Build an artifact of a given type with sensible content for renderer stories. */
export function makeTypedArtifact(
  type: ArtifactType,
  title: string,
  content: string,
  language?: ArtifactLanguage
): Artifact {
  return makeArtifact({ id: `art_${type}`, type, title, content, language, metadata: undefined })
}

/** A small session of mixed-type artifacts for the list view. */
export function makeArtifactList(sessionId = "ses_1"): Artifact[] {
  return [
    makeArtifact({ id: "art_code", sessionId, type: "code", title: "rate-limiter.ts" }),
    makeTypedArtifact("document", "Design notes", "# Design notes\n\n- point one\n- point two"),
    makeTypedArtifact("mermaid", "Flow", "graph TD\n  A[Start] --> B[Done]", "mermaid"),
    makeTypedArtifact("chart", "Weekly errors", "[]"),
  ].map((a) => ({ ...a, sessionId }))
}

export function makeArtifactVersion(over: Partial<ArtifactVersion> = {}): ArtifactVersion {
  return {
    id: `ver_${Math.random().toString(36).slice(2)}`,
    artifactId: "art_1",
    content: "export function rateLimit() {\n  return true\n}\n",
    version: 1,
    createdAt: ARTIFACT_STAMP,
    changeDescription: "Initial draft",
    ...over,
  }
}

export function makeReviewItem(over: Partial<CanvasReviewItem> = {}): CanvasReviewItem {
  return {
    id: `ri_${Math.random().toString(36).slice(2)}`,
    actionType: "improve",
    changeType: "replace",
    originalText: "if (hits.length >= max) return false",
    proposedText: "if (hits.length >= max) { return false }",
    status: "pending",
    range: { startLine: 6, endLine: 6 },
    diffLines: [
      { type: "removed", content: "if (hits.length >= max) return false" },
      { type: "added", content: "if (hits.length >= max) { return false }" },
    ],
    ...over,
  }
}

export function makePendingReview(over: Partial<CanvasPendingReview> = {}): CanvasPendingReview {
  return {
    id: "rev_1",
    requestId: "req_1",
    actionType: "improve",
    originalContent:
      "export function rateLimit(max, windowMs) {\n  const hits = []\n  return () => hits.length < max\n}\n",
    proposedContent:
      "export function rateLimit(max: number, windowMs: number) {\n  const hits: number[] = []\n  return () => {\n    return hits.length < max\n  }\n}\n",
    createdAt: ARTIFACT_STAMP,
    status: "pending",
    items: [
      makeReviewItem({
        changeType: "replace",
        originalText: "export function rateLimit(max, windowMs) {",
        proposedText: "export function rateLimit(max: number, windowMs: number) {",
        range: { startLine: 1, endLine: 1 },
        diffLines: [
          { type: "removed", content: "export function rateLimit(max, windowMs) {" },
          { type: "added", content: "export function rateLimit(max: number, windowMs: number) {" },
        ],
      }),
      makeReviewItem({
        changeType: "insert",
        originalText: "",
        proposedText: "    return hits.length < max",
        range: { startLine: 3, endLine: 4 },
        diffLines: [{ type: "added", content: "    return hits.length < max" }],
      }),
    ],
    ...over,
  }
}

/** A tiny but valid `.ipynb` document for the Jupyter renderer. */
export function makeJupyterNotebook(): JupyterNotebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", language: "python", display_name: "Python 3" },
      language_info: { name: "python", version: "3.11" },
    },
    cells: [
      {
        id: "c1",
        cell_type: "markdown",
        source: "# Sales analysis\n\nLoad the data and plot the weekly totals.",
      },
      {
        id: "c2",
        cell_type: "code",
        execution_count: 1,
        source: "import pandas as pd\ndf = pd.read_csv('sales.csv')\ndf.head()",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 1,
            data: { "text/plain": "   week  total\n0     1   1240\n1     2   1810" },
          },
        ],
      },
      {
        id: "c3",
        cell_type: "code",
        execution_count: 2,
        source: "df.plot(x='week', y='total')",
        outputs: [{ output_type: "stream", name: "stdout", text: "<AxesSubplot: xlabel='week'>" }],
      },
      {
        id: "c4",
        cell_type: "code",
        execution_count: 3,
        source: "raise ValueError('boom')",
        outputs: [
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "boom",
            traceback: ["Traceback (most recent call last):", "ValueError: boom"],
          },
        ],
      },
    ],
  }
}

export const NOTEBOOK_JSON = JSON.stringify(makeJupyterNotebook(), null, 2)
