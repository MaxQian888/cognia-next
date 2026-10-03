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
import * as apiTypes from "./api-types"
import type { DocumentStore } from "./documents"
import type { ConfigurationStore } from "./configuration"
import type { ExtensionRegistry } from "./extensions"
import type { WorkspaceFolders } from "./workspace-folders"
import type { OwnedPaths } from "./workspace-fs"
import type { CancellationToken } from "./types"
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
import type { WebviewRegistry } from "./webviews"
import type { LanguageModels } from "./lm"
import {
  TerminalExitReason,
  TerminalLocation,
  TerminalShellExecutionCommandLineConfidence,
  type TerminalRegistry,
} from "./terminal"
import { createL10nNamespace } from "./l10n"

export interface ShimDependencies {
  extensionId: string
  connection: RpcConnection
  /** The host's open documents and editors (`documents.ts`). */
  documents: DocumentStore
  /** The installed VS Code extensions the renderer reports (`extensions.ts`). */
  extensions: ExtensionRegistry
  /** The settings the renderer reports (`configuration.ts`). */
  configuration: ConfigurationStore
  /** The terminals the host's extensions created (`terminal.ts`). */
  terminals: TerminalRegistry
  /** The webview panels and views the host's extensions show (`webviews.ts`). */
  webviews: WebviewRegistry
  /** The app's language models as the renderer last described them (`lm.ts`). */
  languageModels: LanguageModels
  /** The open workspace folders and file-watcher routing (`workspace-folders.ts`). */
  folders: WorkspaceFolders
  /** The extension's own directories, which `workspace.fs` may use without asking. */
  ownedPaths: () => OwnedPaths
  /**
   * Answer `extension:call`s carrying `token`. `call` names the method the
   * renderer asked for and carries the call's cancellation token.
   */
  registerProviderCallback: (
    token: string,
    cb: (
      payload: unknown,
      call: { method: string; cancellation: CancellationToken }
    ) => Promise<unknown> | unknown
  ) => () => void
}

/**
 * The VS Code API level this shim implements. A semver `version` is what
 * extensions and `vscode-languageclient` (which requires `^1.91.0`) check;
 * mirrored by `SHIM_VSCODE_VERSION` in `lib/plugin/vscode-shim/engine-compat.ts`.
 */
export const SHIM_VSCODE_API_VERSION = "1.91.0"

export function createVscodeShim(deps: ShimDependencies): unknown {
  return {
    // Value types beyond the core ones below.
    ...apiTypes,
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
    TerminalExitReason,
    TerminalLocation,
    TerminalShellExecutionCommandLineConfidence,
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
    l10n: createL10nNamespace(deps),

    // Convenience errors so extensions can `instanceof` them.
    NotSupportedError,

    // Extensions and vscode-languageclient parse this as semver.
    version: SHIM_VSCODE_API_VERSION,
  }
}
