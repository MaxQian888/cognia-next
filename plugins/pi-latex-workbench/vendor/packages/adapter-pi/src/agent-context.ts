import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { getApprovedResource, loadResourceRegistry, loadTemplateRegistry } from "@latexwb/core";
import type { Scope } from "@latexwb/storage";
import type { WorkbenchSession } from "./session.ts";

/** Pi's default identity line — wrong for a session without shell/file tools. */
const PI_CODING_PREAMBLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. " +
  "You help users by reading files, executing commands, editing code, and writing new files.";

const WORKBENCH_PREAMBLE =
  "You are a LaTeX writing and typesetting agent operating inside pi through the controlled " +
  "LaTeX Workbench. You help users draft, revise, typeset, check and release LaTeX documents, " +
  "working only through the latex_* tools: there is no shell and no direct file access, and " +
  "the user's imported folder is not edited in place. Reply in the user's language.";

/**
 * Adapt Pi's base prompt for a bound worker: swap the coding-assistant
 * identity and drop the Pi-documentation pointers (they reference files the
 * model cannot read here). Both are exact-text rewrites that degrade to a
 * no-op if a future Pi changes the wording — the workbench context is
 * appended either way.
 */
export function adaptBasePrompt(systemPrompt: string): string {
  return systemPrompt
    .replace(PI_CODING_PREAMBLE, WORKBENCH_PREAMBLE)
    .replace(/<docs>\n[\s\S]*?\n<\/docs>\n?/, "");
}

/** Latest build of the head snapshot, so a follow-up can reuse its PDF. */
function headBuild(session: WorkbenchSession, scope: Scope, head: string | null) {
  if (head === null) return null;
  // Render/check/bibliography service jobs share the snapshot id; only a
  // build.run job carries the PDF.
  const job = session.store.listJobs(scope, { limit: 200 })
    .find((row) => row["snapshot_id"] === head && row["action"] === "build.run");
  if (job === undefined) return null;
  let status: string | null = null;
  let pdfArtifactId: string | null = null;
  try {
    const result = JSON.parse((job["result_json"] as string | null) ?? "null") as {
      buildResult?: { status?: string; pdfArtifactId?: string | null };
    } | null;
    status = result?.buildResult?.status ?? null;
    pdfArtifactId = result?.buildResult?.pdfArtifactId ?? null;
  } catch {
    // An unparsable result is reported as unknown, never guessed.
  }
  return { jobId: job["job_id"], state: job["state"], status, pdfArtifactId };
}

/**
 * One-line footer status for interactive sessions:
 * "LaTeX demo · head 4f5f2ebc · strict · compiled · 1 awaiting approval".
 */
export function workbenchStatusLine(session: WorkbenchSession): string | undefined {
  const projectId = session.config.projectId;
  if (projectId === null) return undefined;
  if (session.boundaryBroken) return `LaTeX ${projectId} · boundary broken — tools disabled`;
  const scope = session.scopeFor(projectId);
  const project = session.store.getProject(scope);
  if (project === null) return `LaTeX ${projectId} · new project (init from a template) · ${session.protectionMode()}`;
  const head = (project["head_snapshot_id"] as string | null) ?? null;
  const build = headBuild(session, scope, head);
  const pending = session.store.listPatches(scope, { state: "waiting-approval", limit: 20 }).length;
  return [
    `LaTeX ${projectId}`,
    head === null ? "no head" : `head ${head.replace(/^snap-/, "").slice(0, 8)}`,
    session.protectionMode(),
    build === null ? "not built" : (build.status ?? String(build.state)),
    ...(pending > 0 ? [`${pending} awaiting approval (/latex pending)`] : []),
  ].join(" · ");
}

/**
 * Rebuilt each turn: a resumed/forked conversation must not restore an old
 * head. Static guidance comes first (stable across turns, so provider
 * prompt caches keep it); the host-owned binding comes last.
 */
export function workbenchAgentContext(session: WorkbenchSession): string {
  const projectId = session.config.projectId;
  if (projectId === null) return "";
  const scope = session.scopeFor(projectId);
  const resource = (resourceId: string) => getApprovedResource({
    ctx: session.requestContextFor(["skill.resource.read"]),
    repoRoot: session.config.repoRoot,
    resourceId,
  }).content;
  const skills = loadResourceRegistry(session.config.repoRoot)
    .filter((entry) => /^skill:[^:]+$/.test(entry.id))
    .map((entry) => {
      const { frontmatter } = parseFrontmatter(resource(entry.id));
      return `- ${entry.id}: ${String(frontmatter["description"] ?? "")}`;
    });
  const templates = loadTemplateRegistry(session.config.repoRoot)
    .map((entry) => `- ${entry.id} (${entry.engine}/${entry.bibliography}): ${entry.description}`);
  const head = (session.store.getProject(scope)?.["head_snapshot_id"] as string | null | undefined) ?? null;
  const pending = session.store.listPatches(scope, { state: "waiting-approval", limit: 5 })
    .map((row) => row["patch_id"] as string);
  const mode = session.protectionMode();
  const binding = {
    projectId,
    headSnapshotId: head,
    targetIds: session.store.listTargets(scope).map((row) => row["target_id"]),
    headBuild: headBuild(session, scope, head),
    protectionMode: mode,
    patchesWaitingForApproval: pending,
  };
  return [
    resource("prompt:base-system"),
    "Available workbench skills (load only those relevant to the request):",
    ...skills,
    'Load with latex_project {action:"resource", projectId, resourceId:"skill:<name>"}. ' +
      'Use resourceId "skill:<name>:guide" for its guide. Native read/bash are unavailable here; ' +
      "use this resource channel instead of the generic Pi skill file-reading instructions.",
    "Approved templates for a NEW project (latex_project init; pick by language and document type):",
    ...templates,
    `Protection mode "${mode}": ` + (mode === "authoring"
      ? "patches that only ADD protected content (new equations, labels, citations, numbers) apply directly; changing or removing existing protected content still needs a host approval."
      : "any patch touching protected content needs a host approval; an interactive operator is asked when you call apply, otherwise report the patch id and stop."),
    `Host-owned binding at turn start: ${JSON.stringify(binding)}`,
  ].join("\n\n");
}
