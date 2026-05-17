/**
 * Per-extension `vscode` module shim.
 *
 * Every extension that calls `require("vscode")` lands here through the
 * require-hook. The shim is built per extension so namespaces can capture
 * the `extensionId` in closure (no globals).
 *
 * Surface tiers per `~/.claude/plans/vscode-snug-squid.md`:
 *   Tier 1 — real: commands / workspace / window / env / secrets / authentication / tasks / lm / chat / extensions
 *   Tier 2 — Monaco-real: languages.* / activeTextEditor / window.createTextEditorDecorationType / window.createWebviewPanel / window.createTerminal
 *   Tier 4 — NotSupported: debug / scm / tests / comments / notebooks (raw)
 *   Tier 5 — declarative: themes / grammars / iconThemes (loaded by renderer, not here)
 *
 * Every namespace file exports a factory `(deps) => Namespace` so each
 * extension gets its own bound surface.
 */

import { RpcConnection } from "../rpc"
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  MarkdownString,
  NotSupportedError,
  Position,
  Range,
  Selection,
  TextEdit,
  Uri,
  WorkspaceEdit,
  CompletionItemKind,
  DiagnosticSeverity,
  FileType,
  StatusBarAlignment,
  TextDocumentSaveReason,
  ViewColumn,
} from "./types"
import { createCommandsNamespace } from "./commands"
import { createWindowNamespace } from "./window"
import { createWorkspaceNamespace } from "./workspace"
import { createLanguagesNamespace } from "./languages"
import { createEnvNamespace } from "./env"
import { createAuthenticationNamespace } from "./authentication"
import { createTasksNamespace } from "./tasks"
import { createLmNamespace } from "./lm"
import { createChatNamespace } from "./chat"
import { createExtensionsNamespace } from "./extensions"
import { createDebugNamespace } from "./debug"
import { createScmNamespace } from "./scm"
import { createTestsNamespace } from "./tests"
import { createCommentsNamespace } from "./comments"
import { createNotebooksNamespace } from "./notebooks"
import { createTerminalNamespace } from "./terminal"
import { createL10nNamespace } from "./l10n"

export interface ShimDependencies {
  extensionId: string
  connection: RpcConnection
  registerProviderCallback: (
    token: string,
    cb: (payload: unknown) => Promise<unknown> | unknown
  ) => () => void
}

export function createVscodeShim(deps: ShimDependencies): unknown {
  return {
    // Data types
    Position,
    Range,
    Selection,
    Uri,
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    TextEdit,
    WorkspaceEdit,
    MarkdownString,

    // Enums
    FileType,
    TextDocumentSaveReason,
    StatusBarAlignment,
    ViewColumn,
    DiagnosticSeverity,
    CompletionItemKind,

    // Namespaces — each is its own module so the surface is auditable.
    commands: createCommandsNamespace(deps),
    window: createWindowNamespace(deps),
    workspace: createWorkspaceNamespace(deps),
    languages: createLanguagesNamespace(deps),
    env: createEnvNamespace(deps),
    authentication: createAuthenticationNamespace(deps),
    tasks: createTasksNamespace(deps),
    lm: createLmNamespace(deps),
    chat: createChatNamespace(deps),
    extensions: createExtensionsNamespace(deps),
    debug: createDebugNamespace(),
    scm: createScmNamespace(),
    tests: createTestsNamespace(),
    comments: createCommentsNamespace(),
    notebooks: createNotebooksNamespace(),
    terminal: createTerminalNamespace(deps),
    l10n: createL10nNamespace(deps),

    // Convenience errors so extensions can `instanceof` them.
    NotSupportedError,

    // Version metadata — extensions sometimes branch on this.
    version: "cognia-1.74.0",
  }
}
