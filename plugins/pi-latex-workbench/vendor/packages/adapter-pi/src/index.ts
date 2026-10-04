import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkbenchSession } from "./session.ts";
import { registerSessionControl } from "./session-control.ts";
import { registerWorkbenchCommands } from "./agent-commands.ts";
import { projectTool } from "./tools/project.ts";
import { patchTool } from "./tools/patch.ts";
import { buildTool } from "./tools/build.ts";
import { bibTool } from "./tools/bib.ts";
import { figureTool } from "./tools/figure.ts";
import { checkTool } from "./tools/check.ts";
import { renderTool } from "./tools/render.ts";
import { exportTool } from "./tools/export.ts";

export { smokeMessage } from "./smoke.ts";
export { WorkbenchSession, type WorkbenchSessionConfig } from "./session.ts";
export {
  LATEXWB_TOOL_NAMES,
  verifyActiveTools,
  projectTrustResult,
  resourcesDiscoverResult,
  toolCallResult,
  userBashResult,
  registerSessionControl,
  type SessionStartVerification,
} from "./session-control.ts";
export { handleLatexCommand } from "./latex-command.ts";
export * from "./tools/index.ts";
export * from "./envelope.ts";

/** Register the eight latex_* tools bound to this session. */
export function registerWorkbenchTools(pi: ExtensionAPI, session: WorkbenchSession): void {
  pi.registerTool(projectTool(session));
  pi.registerTool(patchTool(session));
  pi.registerTool(buildTool(session));
  pi.registerTool(checkTool(session));
  pi.registerTool(renderTool(session));
  pi.registerTool(bibTool(session));
  pi.registerTool(figureTool(session));
  pi.registerTool(exportTool(session));
}

/**
 * Full controlled-session registration: eight tools, the session-control
 * handlers, and the /latex command. `session` is injectable for tests;
 * production code uses host-owned environment configuration.
 */
export function registerWorkbenchExtension(
  pi: ExtensionAPI,
  session: WorkbenchSession = WorkbenchSession.fromEnv(),
): WorkbenchSession {
  registerWorkbenchTools(pi, session);
  registerSessionControl(pi, session);
  pi.on("session_shutdown", () => session.close());

  registerWorkbenchCommands(pi, session);
  return session;
}
