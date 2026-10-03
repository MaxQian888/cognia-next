/**
 * `vscode.languages`: provider registration, diagnostics, document matching.
 *
 * Registering a provider sends `languages:register` with a token, a kind
 * and a selector; the renderer registers the matching Monaco provider
 * (`lib/plugin/vscode-shim/languages-handler.ts` lists the kinds, and its
 * test reads this file to keep the lists equal). When Monaco needs an
 * answer the renderer sends `extension:call {token, method, payload}`; the
 * handler for that method turns the payload into VS Code arguments (the
 * document from the host's store, positions, a cancellation token, the
 * call's context), calls the provider, and returns its answer in wire form
 * (`provider-wire.ts`).
 */

import process from "node:process"

import { CodeActionTriggerKind } from "./api-types"
import type { DocumentStore, TextDocument } from "./documents"
import type { ShimDependencies } from "./index"
import {
  HierarchyItems,
  toCodeActionKind,
  toColor,
  toDiagnostics,
  toPosition,
  toRange,
  wireCodeActions,
  wireCodeLenses,
  wireColorPresentations,
  wireColors,
  wireCompletions,
  wireDocumentHighlights,
  wireDocumentLinks,
  wireDocumentSymbols,
  wireFoldingRanges,
  wireHover,
  wireInlayHints,
  wireInlineCompletions,
  wireLinkedEditingRanges,
  wireLocations,
  wireRange,
  wireSelectionRanges,
  wireSemanticTokens,
  wireSignatureHelp,
  wireTextEdits,
  wireUri,
  wireWorkspaceEdit,
  wireWorkspaceSymbols,
  type WirePosition,
  type WireRange,
} from "./provider-wire"
import { Disposable, EventEmitter, type CancellationToken, type Uri } from "./types"
import {
  createUnsupportedApiReporter,
  createUnsupportedLanguagesMembers,
} from "./unsupported-members"

type GlobPattern = string | { base?: string; baseUri?: Uri; pattern: string }

interface DocumentFilter {
  language?: string
  scheme?: string
  pattern?: GlobPattern
  notebookType?: string
}

export type DocumentSelector = string | DocumentFilter | ReadonlyArray<string | DocumentFilter>

type WireSelector = Array<
  | string
  | { language?: string; scheme?: string; pattern?: string | { base: string; pattern: string } }
>

type Payload = Record<string, unknown> & { uri?: string; version?: number }
type Handler = (payload: Payload, cancellation: CancellationToken) => unknown

function filtersOf(selector: DocumentSelector): Array<string | DocumentFilter> {
  return Array.isArray(selector) ? [...selector] : [selector as string | DocumentFilter]
}

function wirePattern(pattern: GlobPattern): string | { base: string; pattern: string } {
  if (typeof pattern === "string") return pattern
  return { base: pattern.baseUri?.fsPath ?? pattern.base ?? "", pattern: pattern.pattern }
}

/** A VS Code selector in the form Monaco accepts (it takes the same filters). */
export function wireSelector(selector: DocumentSelector): WireSelector {
  const out: WireSelector = []
  for (const filter of filtersOf(selector)) {
    if (typeof filter === "string") {
      out.push(filter)
    } else if (filter.notebookType === undefined) {
      out.push({
        ...(filter.language ? { language: filter.language } : {}),
        ...(filter.scheme ? { scheme: filter.scheme } : {}),
        ...(filter.pattern !== undefined ? { pattern: wirePattern(filter.pattern) } : {}),
      })
    }
    // Notebook-cell filters match nothing here: there are no notebooks.
  }
  return out.length > 0 ? out : ["*"]
}

/** A glob (`*`, `**`, `?`, `{a,b}`) as a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let source = ""
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` matches any number of directories, including none.
        const slash = glob[index + 2] === "/"
        source += slash ? "(?:.*/)?" : ".*"
        index += slash ? 2 : 1
      } else {
        source += "[^/]*"
      }
    } else if (char === "?") {
      source += "[^/]"
    } else if (char === "{") {
      const close = glob.indexOf("}", index)
      if (close === -1) {
        source += "\\{"
      } else {
        source += `(?:${glob
          .slice(index + 1, close)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`
        index = close
      }
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${source}$`)
}

function patternMatches(pattern: GlobPattern, document: TextDocument): boolean {
  const path = document.uri.fsPath.replace(/\\/g, "/")
  if (typeof pattern === "string") {
    // A pattern without a directory part matches the file name anywhere.
    return globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`).test(path)
  }
  const base = (pattern.baseUri?.fsPath ?? pattern.base ?? "")
    .replace(/\\/g, "/")
    .replace(/\/$/, "")
  if (base && !path.startsWith(`${base}/`)) return false
  return globToRegExp(pattern.pattern).test(base ? path.slice(base.length + 1) : path)
}

/**
 * VS Code's `languages.match`: 10 for an exact match, 5 for a wildcard, 0
 * for none, taking the best filter of the selector.
 */
export function matchSelector(selector: DocumentSelector, document: TextDocument): number {
  let best = 0
  for (const filter of filtersOf(selector)) {
    let score: number
    if (typeof filter === "string") {
      score = filter === document.languageId ? 10 : filter === "*" ? 5 : 0
    } else {
      if (filter.notebookType !== undefined) continue
      score = 0
      let matched = true
      if (filter.language !== undefined) {
        if (filter.language === document.languageId) score = 10
        else if (filter.language === "*") score = Math.max(score, 5)
        else matched = false
      }
      if (matched && filter.scheme !== undefined) {
        if (filter.scheme === document.uri.scheme) score = 10
        else if (filter.scheme === "*") score = Math.max(score, 5)
        else matched = false
      }
      if (matched && filter.pattern !== undefined) {
        if (patternMatches(filter.pattern, document)) score = Math.max(score, 10)
        else matched = false
      }
      if (!matched) score = 0
    }
    best = Math.max(best, score)
  }
  return best
}

const position = (payload: Payload) => toPosition(payload.position as WirePosition)
const range = (payload: Payload) => toRange(payload.range as WireRange)

function formattingOptions(payload: Payload): { tabSize: number; insertSpaces: boolean } {
  const options = (payload.options ?? {}) as { tabSize?: number; insertSpaces?: boolean }
  return { tabSize: options.tabSize ?? 2, insertSpaces: options.insertSpaces ?? true }
}

/**
 * A language configuration holds `RegExp`s (word pattern, indentation and
 * on-enter rules), which JSON drops. Each becomes `{$regexp, flags}`, which
 * the renderer turns back into a `RegExp`.
 */
export function encodeRegExps(value: unknown): unknown {
  if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags }
  if (Array.isArray(value)) return value.map(encodeRegExps)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeRegExps(entry)])
    )
  }
  return value
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLanguagesNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  const documents: DocumentStore = deps.documents
  const hierarchyItems = new HierarchyItems()
  const diagnosticCollections = new Map<string, Map<string, unknown[]>>()
  const diagnosticsChanged = new EventEmitter<{ uris: readonly Uri[] }>()

  /** Run `fn` with the document a call is about; no open document, no answer. */
  async function withDocument<T>(
    payload: Payload,
    fn: (document: TextDocument) => T
  ): Promise<Awaited<T> | null> {
    const document = await documents.waitForVersion(String(payload.uri), payload.version)
    return document ? await fn(document) : null
  }

  function registerProvider(
    kind: string,
    selector: DocumentSelector,
    handlers: Record<string, Handler>,
    extra?: Record<string, unknown>
  ): Disposable {
    const token = `prov:${extensionId}:${kind}:${Math.random().toString(36).slice(2, 10)}`
    const unsubscribe = registerProviderCallback(token, (payload, { method, cancellation }) => {
      const handler = handlers[method]
      if (!handler) throw new Error(`The ${kind} provider has no ${method}`)
      return handler((payload ?? {}) as Payload, cancellation)
    })
    connection
      .sendRequest<{ supported?: boolean }>("languages:register", {
        extensionId,
        kind,
        token,
        selector: wireSelector(selector),
        ...extra,
      })
      .then(
        (result) => {
          if (result?.supported === false) {
            process.stderr.write(
              `[vscode-shim] ${extensionId}: the editor has no ${kind} feature; the provider is kept but never called\n`
            )
          }
        },
        (error: unknown) => {
          process.stderr.write(
            `[vscode-shim] ${extensionId}: registering a ${kind} provider failed: ${describeError(error)}\n`
          )
        }
      )
    return new Disposable(() => {
      unsubscribe()
      void connection.sendNotification("languages:unregister", { token })
    })
  }

  type Provider = Record<string, (...args: never[]) => unknown>
  const invoke = (provider: Provider, method: string, ...args: unknown[]) =>
    (provider[method] as (...a: unknown[]) => unknown).call(provider, ...args)

  function registerLocationProvider(kind: string, method: string) {
    return (selector: DocumentSelector, provider: Provider) =>
      registerProvider(kind, selector, {
        [method]: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireLocations(await invoke(provider, method, document, position(payload), cancellation))
          ),
      })
  }

  function setDiagnostics(
    collectionName: string,
    byUri: Map<string, unknown[]>,
    uri: unknown,
    list: unknown[] | undefined
  ) {
    const key = String(uri)
    if (!list || list.length === 0) {
      byUri.delete(key)
      void connection.sendNotification("languages:clearDiagnostics", {
        extensionId,
        collectionName,
        uri: key,
      })
    } else {
      byUri.set(key, list)
      void connection.sendNotification("languages:setDiagnostics", {
        extensionId,
        collectionName,
        uri: key,
        diagnostics: list,
      })
    }
    diagnosticsChanged.fire({ uris: [uri as Uri] })
  }

  return {
    registerCompletionItemProvider(
      selector: DocumentSelector,
      provider: Provider,
      ...triggerCharacters: string[]
    ) {
      return registerProvider(
        "completionItem",
        selector,
        {
          provideCompletionItems: (payload, cancellation) =>
            withDocument(payload, async (document) => {
              const context = (payload.context ?? { triggerKind: 0 }) as {
                triggerKind: number
                triggerCharacter?: string
              }
              const result = await invoke(
                provider,
                "provideCompletionItems",
                document,
                position(payload),
                cancellation,
                context
              )
              return wireCompletions(result)
            }),
        },
        { triggerCharacters }
      )
    },
    registerHoverProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("hover", selector, {
        provideHover: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireHover(
              await invoke(provider, "provideHover", document, position(payload), cancellation)
            )
          ),
      })
    },
    registerDefinitionProvider: registerLocationProvider("definition", "provideDefinition"),
    registerDeclarationProvider: registerLocationProvider("declaration", "provideDeclaration"),
    registerTypeDefinitionProvider: registerLocationProvider(
      "typeDefinition",
      "provideTypeDefinition"
    ),
    registerImplementationProvider: registerLocationProvider(
      "implementation",
      "provideImplementation"
    ),
    registerReferenceProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("references", selector, {
        provideReferences: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireLocations(
              await invoke(
                provider,
                "provideReferences",
                document,
                position(payload),
                payload.context ?? { includeDeclaration: true },
                cancellation
              )
            )
          ),
      })
    },
    registerDocumentHighlightProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("documentHighlight", selector, {
        provideDocumentHighlights: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireDocumentHighlights(
              await invoke(
                provider,
                "provideDocumentHighlights",
                document,
                position(payload),
                cancellation
              )
            )
          ),
      })
    },
    registerDocumentFormattingEditProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("documentFormatting", selector, {
        provideDocumentFormattingEdits: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireTextEdits(
              await invoke(
                provider,
                "provideDocumentFormattingEdits",
                document,
                formattingOptions(payload),
                cancellation
              )
            )
          ),
      })
    },
    registerDocumentRangeFormattingEditProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("documentRangeFormatting", selector, {
        provideDocumentRangeFormattingEdits: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireTextEdits(
              await invoke(
                provider,
                "provideDocumentRangeFormattingEdits",
                document,
                range(payload),
                formattingOptions(payload),
                cancellation
              )
            )
          ),
      })
    },
    registerOnTypeFormattingEditProvider(
      selector: DocumentSelector,
      provider: Provider,
      firstTriggerCharacter: string,
      ...moreTriggerCharacter: string[]
    ) {
      return registerProvider(
        "onTypeFormatting",
        selector,
        {
          provideOnTypeFormattingEdits: (payload, cancellation) =>
            withDocument(payload, async (document) =>
              wireTextEdits(
                await invoke(
                  provider,
                  "provideOnTypeFormattingEdits",
                  document,
                  position(payload),
                  String(payload.ch ?? ""),
                  formattingOptions(payload),
                  cancellation
                )
              )
            ),
        },
        { firstTriggerCharacter, moreTriggerCharacter }
      )
    },
    registerSignatureHelpProvider(
      selector: DocumentSelector,
      provider: Provider,
      ...metadataOrTriggers: Array<
        string | { triggerCharacters?: string[]; retriggerCharacters?: string[] }
      >
    ) {
      // Either `(selector, provider, metadata)` or the older `(selector, provider, ...chars)`.
      const metadata =
        typeof metadataOrTriggers[0] === "object"
          ? (metadataOrTriggers[0] as {
              triggerCharacters?: string[]
              retriggerCharacters?: string[]
            })
          : { triggerCharacters: metadataOrTriggers as string[], retriggerCharacters: [] }
      return registerProvider(
        "signatureHelp",
        selector,
        {
          provideSignatureHelp: (payload, cancellation) =>
            withDocument(payload, async (document) => {
              const context = (payload.context ?? {}) as {
                triggerKind?: number
                triggerCharacter?: string
                isRetrigger?: boolean
              }
              return wireSignatureHelp(
                await invoke(
                  provider,
                  "provideSignatureHelp",
                  document,
                  position(payload),
                  cancellation,
                  {
                    triggerKind: context.triggerKind ?? 1,
                    triggerCharacter: context.triggerCharacter,
                    isRetrigger: context.isRetrigger ?? false,
                    activeSignatureHelp: undefined,
                  }
                )
              )
            }),
        },
        {
          triggerCharacters: metadata.triggerCharacters ?? [],
          retriggerCharacters: metadata.retriggerCharacters ?? [],
        }
      )
    },
    registerCodeActionsProvider(
      selector: DocumentSelector,
      provider: Provider,
      metadata?: { providedCodeActionKinds?: ReadonlyArray<{ value: string }> }
    ) {
      return registerProvider(
        "codeActions",
        selector,
        {
          provideCodeActions: (payload, cancellation) =>
            withDocument(payload, async (document) => {
              const context = (payload.context ?? {}) as {
                diagnostics?: Parameters<typeof toDiagnostics>[0]
                only?: string
                triggerKind?: number
              }
              return wireCodeActions(
                await invoke(
                  provider,
                  "provideCodeActions",
                  document,
                  range(payload),
                  {
                    diagnostics: toDiagnostics(context.diagnostics ?? []),
                    only: toCodeActionKind(context.only),
                    triggerKind: context.triggerKind ?? CodeActionTriggerKind.Invoke,
                  },
                  cancellation
                )
              )
            }),
        },
        {
          providedKinds: (metadata?.providedCodeActionKinds ?? []).map((kind) => kind.value),
        }
      )
    },
    registerCodeLensProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("codeLens", selector, {
        provideCodeLenses: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const lenses = await invoke(provider, "provideCodeLenses", document, cancellation)
            if (!Array.isArray(lenses)) return null
            // Monaco shows a lens once; resolve the unresolved ones first.
            const resolved = await Promise.all(
              lenses.map(async (lens: { command?: unknown }) =>
                lens.command === undefined && typeof provider.resolveCodeLens === "function"
                  ? ((await invoke(provider, "resolveCodeLens", lens, cancellation)) ?? lens)
                  : lens
              )
            )
            return wireCodeLenses(resolved)
          }),
      })
    },
    registerInlineCompletionItemProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("inlineCompletion", selector, {
        provideInlineCompletionItems: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const context = (payload.context ?? {}) as { triggerKind?: number }
            return wireInlineCompletions(
              await invoke(
                provider,
                "provideInlineCompletionItems",
                document,
                position(payload),
                { triggerKind: context.triggerKind ?? 1, selectedCompletionInfo: undefined },
                cancellation
              )
            )
          }),
      })
    },
    registerDocumentSymbolProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("documentSymbol", selector, {
        provideDocumentSymbols: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireDocumentSymbols(
              await invoke(provider, "provideDocumentSymbols", document, cancellation)
            )
          ),
      })
    },
    registerWorkspaceSymbolProvider(provider: Provider) {
      return registerProvider("workspaceSymbol", "*", {
        provideWorkspaceSymbols: async (payload, cancellation) =>
          wireWorkspaceSymbols(
            await invoke(
              provider,
              "provideWorkspaceSymbols",
              String(payload.query ?? ""),
              cancellation
            )
          ),
      })
    },
    registerRenameProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("rename", selector, {
        provideRenameEdits: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const edit = await invoke(
              provider,
              "provideRenameEdits",
              document,
              position(payload),
              String(payload.newName ?? ""),
              cancellation
            )
            return edit ? wireWorkspaceEdit(edit) : null
          }),
        prepareRename: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            if (typeof provider.prepareRename !== "function") return null
            try {
              const result = (await invoke(
                provider,
                "prepareRename",
                document,
                position(payload),
                cancellation
              )) as
                | { start: WirePosition; end: WirePosition }
                | { range: WireRange; placeholder: string }
                | null
              if (!result) return null
              if ("range" in result)
                return { range: wireRange(result.range), text: result.placeholder }
              return { range: wireRange(result), text: document.getText(toRange(result)) }
            } catch (error) {
              // VS Code: throwing from prepareRename rejects the rename with that message.
              return { rejectReason: describeError(error) }
            }
          }),
      })
    },
    registerDocumentSemanticTokensProvider(
      selector: DocumentSelector,
      provider: Provider,
      legend: unknown
    ) {
      return registerProvider(
        "documentSemanticTokens",
        selector,
        {
          provideDocumentSemanticTokens: (payload, cancellation) =>
            withDocument(payload, async (document) =>
              wireSemanticTokens(
                await invoke(provider, "provideDocumentSemanticTokens", document, cancellation)
              )
            ),
        },
        { legend }
      )
    },
    registerDocumentRangeSemanticTokensProvider(
      selector: DocumentSelector,
      provider: Provider,
      legend: unknown
    ) {
      return registerProvider(
        "documentRangeSemanticTokens",
        selector,
        {
          provideDocumentRangeSemanticTokens: (payload, cancellation) =>
            withDocument(payload, async (document) =>
              wireSemanticTokens(
                await invoke(
                  provider,
                  "provideDocumentRangeSemanticTokens",
                  document,
                  range(payload),
                  cancellation
                )
              )
            ),
        },
        { legend }
      )
    },
    registerColorProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("color", selector, {
        provideDocumentColors: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireColors(await invoke(provider, "provideDocumentColors", document, cancellation))
          ),
        provideColorPresentations: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const info = payload.colorInfo as {
              range: WireRange
              color: { red: number; green: number; blue: number; alpha: number }
            }
            return wireColorPresentations(
              await invoke(
                provider,
                "provideColorPresentations",
                toColor(info.color),
                { document, range: toRange(info.range) },
                cancellation
              )
            )
          }),
      })
    },
    registerFoldingRangeProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("foldingRange", selector, {
        provideFoldingRanges: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireFoldingRanges(
              await invoke(provider, "provideFoldingRanges", document, {}, cancellation)
            )
          ),
      })
    },
    registerSelectionRangeProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("selectionRange", selector, {
        provideSelectionRanges: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireSelectionRanges(
              await invoke(
                provider,
                "provideSelectionRanges",
                document,
                ((payload.positions ?? []) as WirePosition[]).map(toPosition),
                cancellation
              )
            )
          ),
      })
    },
    registerDocumentLinkProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("documentLink", selector, {
        provideDocumentLinks: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const links = await invoke(provider, "provideDocumentLinks", document, cancellation)
            if (!Array.isArray(links)) return null
            const resolved = await Promise.all(
              links.map(async (link: { target?: unknown }) =>
                link.target === undefined && typeof provider.resolveDocumentLink === "function"
                  ? ((await invoke(provider, "resolveDocumentLink", link, cancellation)) ?? link)
                  : link
              )
            )
            return wireDocumentLinks(resolved)
          }),
      })
    },
    registerInlayHintsProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("inlayHints", selector, {
        provideInlayHints: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireInlayHints(
              await invoke(provider, "provideInlayHints", document, range(payload), cancellation)
            )
          ),
      })
    },
    registerCallHierarchyProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("callHierarchy", selector, {
        prepareCallHierarchy: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const result = await invoke(
              provider,
              "prepareCallHierarchy",
              document,
              position(payload),
              cancellation
            )
            const items = result == null ? [] : Array.isArray(result) ? result : [result]
            return items.map((item) => hierarchyItems.wire(item))
          }),
        provideIncomingCalls: async (payload, cancellation) => {
          const item = hierarchyItems.revive(payload.item)
          if (!item) return null
          const calls = await invoke(
            provider,
            "provideCallHierarchyIncomingCalls",
            item,
            cancellation
          )
          return Array.isArray(calls)
            ? calls.map((entry: { from: unknown; fromRanges: WireRange[] }) => ({
                from: hierarchyItems.wire(entry.from),
                fromRanges: entry.fromRanges.map(wireRange),
              }))
            : null
        },
        provideOutgoingCalls: async (payload, cancellation) => {
          const item = hierarchyItems.revive(payload.item)
          if (!item) return null
          const calls = await invoke(
            provider,
            "provideCallHierarchyOutgoingCalls",
            item,
            cancellation
          )
          return Array.isArray(calls)
            ? calls.map((entry: { to: unknown; fromRanges: WireRange[] }) => ({
                to: hierarchyItems.wire(entry.to),
                fromRanges: entry.fromRanges.map(wireRange),
              }))
            : null
        },
      })
    },
    registerTypeHierarchyProvider(selector: DocumentSelector, provider: Provider) {
      const related =
        (method: string) => async (payload: Payload, cancellation: CancellationToken) => {
          const item = hierarchyItems.revive(payload.item)
          if (!item) return null
          const items = await invoke(provider, method, item, cancellation)
          return Array.isArray(items) ? items.map((entry) => hierarchyItems.wire(entry)) : null
        }
      return registerProvider("typeHierarchy", selector, {
        prepareTypeHierarchy: (payload, cancellation) =>
          withDocument(payload, async (document) => {
            const result = await invoke(
              provider,
              "prepareTypeHierarchy",
              document,
              position(payload),
              cancellation
            )
            const items = result == null ? [] : Array.isArray(result) ? result : [result]
            return items.map((item) => hierarchyItems.wire(item))
          }),
        provideSupertypes: related("provideTypeHierarchySupertypes"),
        provideSubtypes: related("provideTypeHierarchySubtypes"),
      })
    },
    registerLinkedEditingRangeProvider(selector: DocumentSelector, provider: Provider) {
      return registerProvider("linkedEditingRange", selector, {
        provideLinkedEditingRanges: (payload, cancellation) =>
          withDocument(payload, async (document) =>
            wireLinkedEditingRanges(
              await invoke(
                provider,
                "provideLinkedEditingRanges",
                document,
                position(payload),
                cancellation
              )
            )
          ),
      })
    },

    createDiagnosticCollection(name?: string) {
      const collectionName = name ?? `${extensionId}-default`
      const byUri = new Map<string, unknown[]>()
      diagnosticCollections.set(collectionName, byUri)
      const collection = {
        name: collectionName,
        /** `set(uri, diagnostics)`, or `set([[uri, diagnostics], ...])`. */
        set(uriOrEntries: unknown, diagnostics?: unknown[]) {
          if (Array.isArray(uriOrEntries)) {
            // Entries for one URI accumulate; an `undefined` list clears it.
            const merged = new Map<string, { uri: unknown; list: unknown[] | undefined }>()
            for (const [uri, list] of uriOrEntries as Array<[unknown, unknown[] | undefined]>) {
              const key = String(uri)
              const previous = merged.get(key)
              merged.set(key, {
                uri,
                list: list === undefined ? undefined : [...(previous?.list ?? []), ...list],
              })
            }
            for (const { uri, list } of merged.values())
              setDiagnostics(collectionName, byUri, uri, list)
            return
          }
          setDiagnostics(collectionName, byUri, uriOrEntries, diagnostics)
        },
        delete(uri: unknown) {
          setDiagnostics(collectionName, byUri, uri, [])
        },
        clear() {
          for (const uri of [...byUri.keys()]) setDiagnostics(collectionName, byUri, uri, [])
        },
        forEach(callback: (uri: unknown, diagnostics: unknown[], collection: unknown) => void) {
          for (const [key, list] of byUri) callback(key, list, collection)
        },
        get(uri: unknown): readonly unknown[] | undefined {
          return byUri.get(String(uri))
        },
        has(uri: unknown): boolean {
          return byUri.has(String(uri))
        },
        [Symbol.iterator]: function* () {
          yield* byUri.entries()
        },
        dispose() {
          collection.clear()
          diagnosticCollections.delete(collectionName)
        },
      }
      return collection
    },
    /** This extension's diagnostics for `uri`, or every URI with diagnostics. */
    getDiagnostics(uri?: unknown) {
      if (uri !== undefined) {
        const key = String(uri)
        return [...diagnosticCollections.values()].flatMap((byUri) => byUri.get(key) ?? [])
      }
      const all = new Map<string, unknown[]>()
      for (const byUri of diagnosticCollections.values()) {
        for (const [key, list] of byUri) all.set(key, [...(all.get(key) ?? []), ...list])
      }
      return [...all]
    },
    onDidChangeDiagnostics: diagnosticsChanged.event,
    match(selector: DocumentSelector, document: TextDocument) {
      return matchSelector(selector, document)
    },
    async setTextDocumentLanguage(document: TextDocument, languageId: string) {
      const uri = wireUri(document.uri)
      await connection.sendRequest("languages:setTextDocumentLanguage", {
        extensionId,
        uri,
        languageId,
      })
      // The renderer's report of the change may come after this answer;
      // apply it here so the returned document already has the new language.
      documents.setLanguage(uri, languageId)
      return documents.get(uri) ?? document
    },
    getLanguages() {
      return connection.sendRequest<string[]>("languages:list", {})
    },
    setLanguageConfiguration(language: string, configuration: unknown) {
      const handle = `langconf:${extensionId}:${Math.random().toString(36).slice(2, 10)}`
      connection
        .sendRequest("languages:setLanguageConfiguration", {
          extensionId,
          handle,
          language,
          configuration: encodeRegExps(configuration),
        })
        .catch((error: unknown) => {
          process.stderr.write(
            `[vscode-shim] ${extensionId}: setting the ${language} language configuration failed: ${describeError(error)}\n`
          )
        })
      return new Disposable(() => {
        void connection.sendNotification("languages:disposeLanguageConfiguration", { handle })
      })
    },
    ...createUnsupportedLanguagesMembers(createUnsupportedApiReporter(connection, extensionId)),
  }
}
