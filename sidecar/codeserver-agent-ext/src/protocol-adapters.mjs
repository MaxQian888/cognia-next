/**
 * Native Code 1.128 projections for Cognia-owned protocol sessions.
 *
 * Protocol processes never run in this extension host. The generated proxy
 * registers native IDE surfaces and every request crosses the authenticated
 * broker to a supervised process owned by the Cognia runtime.
 */

import { createLspConverters } from "./lsp-converters.mjs"
import { probe } from "./test-probe.mjs"
import { createHash } from "node:crypto"
import { realpath, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

export async function registerManagedProtocols(vscode, descriptor, broker) {
  const registrations = []
  try {
    for (const server of descriptor.protocols?.lsp ?? []) {
      registrations.push(await registerLsp(vscode, server, broker))
    }
    for (const server of descriptor.protocols?.dap ?? []) {
      registrations.push(await registerDap(vscode, server, broker))
    }
    for (const server of descriptor.protocols?.mcp ?? []) {
      registrations.push(await registerMcp(vscode, server, broker))
    }
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose()
    throw error
  }
  return combine(vscode, ...registrations)
}

/**
 * Which server capability each VS Code registration needs. The client tells
 * the server `dynamicRegistration: false`, so the capabilities `initialize`
 * returned are the whole truth: a feature the server did not claim is never
 * registered, and VS Code never sends it a request it would refuse.
 */
const LSP_FEATURE_CAPABILITY = {
  registerCompletionItemProvider: "completionProvider",
  registerHoverProvider: "hoverProvider",
  registerDeclarationProvider: "declarationProvider",
  registerDefinitionProvider: "definitionProvider",
  registerTypeDefinitionProvider: "typeDefinitionProvider",
  registerImplementationProvider: "implementationProvider",
  registerReferenceProvider: "referencesProvider",
  registerDocumentHighlightProvider: "documentHighlightProvider",
  registerDocumentSymbolProvider: "documentSymbolProvider",
  registerCodeActionsProvider: "codeActionProvider",
  registerCodeLensProvider: "codeLensProvider",
  registerDocumentLinkProvider: "documentLinkProvider",
  registerColorProvider: "colorProvider",
  registerDocumentFormattingEditProvider: "documentFormattingProvider",
  registerDocumentRangeFormattingEditProvider: "documentRangeFormattingProvider",
  registerOnTypeFormattingEditProvider: "documentOnTypeFormattingProvider",
  registerRenameProvider: "renameProvider",
  registerFoldingRangeProvider: "foldingRangeProvider",
  registerSelectionRangeProvider: "selectionRangeProvider",
  registerSignatureHelpProvider: "signatureHelpProvider",
  registerInlineValuesProvider: "inlineValueProvider",
  registerInlayHintsProvider: "inlayHintProvider",
  registerLinkedEditingRangeProvider: "linkedEditingRangeProvider",
  registerCallHierarchyProvider: "callHierarchyProvider",
  registerTypeHierarchyProvider: "typeHierarchyProvider",
  registerWorkspaceSymbolProvider: "workspaceSymbolProvider",
}

/** Whether a server capability is claimed: `true` or an options object. */
const claims = (capabilities, name) => {
  const value = capabilities[name]
  return value !== undefined && value !== null && value !== false
}

async function registerLsp(vscode, server, broker) {
  // Monaco owns a separate `monaco` consumer. Never share process state,
  // document versions, or cancellation IDs with the Pro IDE projection.
  const consumerId = "pro-ide"
  const started = await broker.startProtocol("lsp", server, consumerId)
  const ticket = started.capabilityTicket
  // A host too old to report capabilities gets every feature, as before.
  const capabilities = started.connection?.capabilities
  const selector = (server.languages?.length ? server.languages : ["*"]).map((language) => ({
    language,
    scheme: "file",
  }))
  const convert = createLspConverters(vscode)
  const request = (method, payload, token) =>
    broker.requestProtocol("lsp", server, ticket, method, payload, token, consumerId)
  const registrations = []
  const refresh = {
    semanticTokens: createRefreshEmitter(vscode, registrations),
    codeLens: createRefreshEmitter(vscode, registrations),
    inlayHint: createRefreshEmitter(vscode, registrations),
    inlineValue: createRefreshEmitter(vscode, registrations),
    diagnostic: createRefreshEmitter(vscode, registrations),
    foldingRange: createRefreshEmitter(vscode, registrations),
  }
  const progress = createWorkDoneProgress(vscode, request)
  const register = (method, implementation, ...args) => {
    const capability = LSP_FEATURE_CAPABILITY[method]
    if (capabilities && capability && !claims(capabilities, capability)) return
    if (typeof vscode.languages?.[method] !== "function") {
      throw compatibilityError("IDE_CODE_API_UNAVAILABLE", `Code 1.128 languages.${method}`)
    }
    registrations.push(vscode.languages[method](selector, implementation, ...args))
  }
  const textDocument = (document) => ({ textDocument: { uri: document.uri.toString() } })
  const documentPosition = (document, position) => ({
    ...textDocument(document),
    position: convert.toPosition(position),
  })
  const reviveEdit = (edit) => reviveWorkspaceEdit(vscode, edit)
  const triggers = (name, field) => {
    const value = capabilities?.[name]?.[field]
    return Array.isArray(value) ? value : []
  }

  register(
    "registerCompletionItemProvider",
    {
      provideCompletionItems: (document, position, token, context) =>
        request(
          "textDocument/completion",
          {
            ...documentPosition(document, position),
            context: convert.toCompletionContext(context),
          },
          token
        ).then(convert.completion),
      ...(capabilities?.completionProvider?.resolveProvider !== false
        ? {
            resolveCompletionItem: async (item, token) => {
              const original = convert.originOf(item)
              if (!original) return item
              const resolved = await request("completionItem/resolve", original, token)
              return resolved ? convert.completionItem(resolved) : item
            },
          }
        : {}),
    },
    ...triggers("completionProvider", "triggerCharacters")
  )
  register("registerHoverProvider", {
    provideHover: (document, position, token) =>
      request("textDocument/hover", documentPosition(document, position), token).then(
        convert.hover
      ),
  })
  for (const [method, provide, lspMethod] of [
    ["registerDeclarationProvider", "provideDeclaration", "textDocument/declaration"],
    ["registerDefinitionProvider", "provideDefinition", "textDocument/definition"],
    ["registerTypeDefinitionProvider", "provideTypeDefinition", "textDocument/typeDefinition"],
    ["registerImplementationProvider", "provideImplementation", "textDocument/implementation"],
  ]) {
    register(method, {
      [provide]: (document, position, token) =>
        request(lspMethod, documentPosition(document, position), token).then(convert.definition),
    })
  }
  register("registerReferenceProvider", {
    provideReferences: (document, position, context, token) =>
      request(
        "textDocument/references",
        {
          ...documentPosition(document, position),
          context: { includeDeclaration: context?.includeDeclaration === true },
        },
        token
      ).then(convert.locations),
  })
  register("registerDocumentHighlightProvider", {
    provideDocumentHighlights: (document, position, token) =>
      request("textDocument/documentHighlight", documentPosition(document, position), token).then(
        convert.documentHighlights
      ),
  })
  register("registerDocumentSymbolProvider", {
    provideDocumentSymbols: (document, token) =>
      request("textDocument/documentSymbol", textDocument(document), token).then(
        convert.documentSymbols
      ),
  })
  register(
    "registerCodeActionsProvider",
    {
      provideCodeActions: (document, range, context, token) =>
        request(
          "textDocument/codeAction",
          {
            ...textDocument(document),
            range: convert.toRange(range),
            context: convert.toCodeActionContext(context),
          },
          token
        ).then((value) => convert.codeActions(value, reviveEdit)),
      ...(capabilities?.codeActionProvider?.resolveProvider
        ? {
            resolveCodeAction: async (action, token) => {
              const original = convert.originOf(action)
              if (!original) return action
              const resolved = await request("codeAction/resolve", original, token)
              return resolved ? convert.applyCodeAction(action, resolved, reviveEdit) : action
            },
          }
        : {}),
    },
    Array.isArray(capabilities?.codeActionProvider?.codeActionKinds)
      ? {
          providedCodeActionKinds: capabilities.codeActionProvider.codeActionKinds.map((kind) =>
            vscode.CodeActionKind.Empty.append(kind)
          ),
        }
      : undefined
  )
  register("registerCodeLensProvider", {
    onDidChangeCodeLenses: refresh.codeLens.event,
    provideCodeLenses: (document, token) =>
      request("textDocument/codeLens", textDocument(document), token).then(convert.codeLenses),
    ...(capabilities?.codeLensProvider?.resolveProvider !== false
      ? {
          resolveCodeLens: async (lens, token) => {
            const original = convert.originOf(lens)
            if (!original || lens.command) return lens
            const resolved = await request("codeLens/resolve", original, token)
            if (resolved?.command) lens.command = convert.command(resolved.command)
            return lens
          },
        }
      : {}),
  })
  register("registerDocumentLinkProvider", {
    provideDocumentLinks: (document, token) =>
      request("textDocument/documentLink", textDocument(document), token).then(
        convert.documentLinks
      ),
    ...(capabilities?.documentLinkProvider?.resolveProvider
      ? {
          resolveDocumentLink: async (link, token) => {
            const original = convert.originOf(link)
            if (!original) return link
            const resolved = await request("documentLink/resolve", original, token)
            return resolved ? convert.documentLink(resolved) : link
          },
        }
      : {}),
  })
  register("registerColorProvider", {
    provideDocumentColors: (document, token) =>
      request("textDocument/documentColor", textDocument(document), token).then(
        convert.colorInformation
      ),
    provideColorPresentations: (color, context, token) =>
      request(
        "textDocument/colorPresentation",
        {
          ...textDocument(context.document),
          color: { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
          range: convert.toRange(context.range),
        },
        token
      ).then(convert.colorPresentations),
  })
  const formattingOptions = (options) => ({ ...plain(options) })
  register("registerDocumentFormattingEditProvider", {
    provideDocumentFormattingEdits: (document, options, token) =>
      request(
        "textDocument/formatting",
        { ...textDocument(document), options: formattingOptions(options) },
        token
      ).then(convert.textEdits),
  })
  register("registerDocumentRangeFormattingEditProvider", {
    provideDocumentRangeFormattingEdits: (document, range, options, token) =>
      request(
        "textDocument/rangeFormatting",
        {
          ...textDocument(document),
          range: convert.toRange(range),
          options: formattingOptions(options),
        },
        token
      ).then(convert.textEdits),
  })
  const onType = capabilities?.documentOnTypeFormattingProvider
  register(
    "registerOnTypeFormattingEditProvider",
    {
      provideOnTypeFormattingEdits: (document, position, character, options, token) =>
        request(
          "textDocument/onTypeFormatting",
          {
            ...documentPosition(document, position),
            ch: character,
            options: formattingOptions(options),
          },
          token
        ).then(convert.textEdits),
    },
    onType?.firstTriggerCharacter ?? "\n",
    ...(Array.isArray(onType?.moreTriggerCharacter) ? onType.moreTriggerCharacter : [])
  )
  register("registerRenameProvider", {
    provideRenameEdits: (document, position, newName, token) =>
      request(
        "textDocument/rename",
        { ...documentPosition(document, position), newName },
        token
      ).then(reviveEdit),
    ...(!capabilities || capabilities.renameProvider?.prepareProvider
      ? {
          prepareRename: (document, position, token) =>
            request("textDocument/prepareRename", documentPosition(document, position), token).then(
              convert.prepareRename
            ),
        }
      : {}),
  })
  register("registerFoldingRangeProvider", {
    onDidChangeFoldingRanges: refresh.foldingRange.event,
    provideFoldingRanges: (document, _context, token) =>
      request("textDocument/foldingRange", textDocument(document), token).then(
        convert.foldingRanges
      ),
  })
  register("registerSelectionRangeProvider", {
    provideSelectionRanges: (document, positions, token) =>
      request(
        "textDocument/selectionRange",
        { ...textDocument(document), positions: positions.map(convert.toPosition) },
        token
      ).then(convert.selectionRanges),
  })
  register(
    "registerSignatureHelpProvider",
    {
      provideSignatureHelp: (document, position, token, context) =>
        request(
          "textDocument/signatureHelp",
          {
            ...documentPosition(document, position),
            context: convert.toSignatureHelpContext(context),
          },
          token
        ).then(convert.signatureHelp),
    },
    {
      triggerCharacters: triggers("signatureHelpProvider", "triggerCharacters"),
      retriggerCharacters: triggers("signatureHelpProvider", "retriggerCharacters"),
    }
  )
  register("registerInlineValuesProvider", {
    onDidChangeInlineValues: refresh.inlineValue.event,
    provideInlineValues: (document, range, context, token) =>
      request(
        "textDocument/inlineValue",
        {
          ...textDocument(document),
          range: convert.toRange(range),
          context: convert.toInlineValueContext(context),
        },
        token
      ).then(convert.inlineValues),
  })
  register("registerInlayHintsProvider", {
    onDidChangeInlayHints: refresh.inlayHint.event,
    provideInlayHints: (document, range, token) =>
      request(
        "textDocument/inlayHint",
        { ...textDocument(document), range: convert.toRange(range) },
        token
      ).then(convert.inlayHints),
    ...(capabilities?.inlayHintProvider?.resolveProvider
      ? {
          resolveInlayHint: async (hint, token) => {
            const original = convert.originOf(hint)
            if (!original) return hint
            const resolved = await request("inlayHint/resolve", original, token)
            return resolved ? convert.inlayHint(resolved) : hint
          },
        }
      : {}),
  })
  register("registerLinkedEditingRangeProvider", {
    provideLinkedEditingRanges: (document, position, token) =>
      request("textDocument/linkedEditingRange", documentPosition(document, position), token).then(
        convert.linkedEditingRanges
      ),
  })
  register("registerCallHierarchyProvider", {
    prepareCallHierarchy: (document, position, token) =>
      request(
        "textDocument/prepareCallHierarchy",
        documentPosition(document, position),
        token
      ).then(convert.callHierarchyItems),
    provideCallHierarchyIncomingCalls: (item, token) =>
      request("callHierarchy/incomingCalls", { item: convert.toHierarchyItem(item) }, token).then(
        convert.incomingCalls
      ),
    provideCallHierarchyOutgoingCalls: (item, token) =>
      request("callHierarchy/outgoingCalls", { item: convert.toHierarchyItem(item) }, token).then(
        convert.outgoingCalls
      ),
  })
  register("registerTypeHierarchyProvider", {
    prepareTypeHierarchy: (document, position, token) =>
      request(
        "textDocument/prepareTypeHierarchy",
        documentPosition(document, position),
        token
      ).then(convert.typeHierarchyItems),
    provideTypeHierarchySupertypes: (item, token) =>
      request("typeHierarchy/supertypes", { item: convert.toHierarchyItem(item) }, token).then(
        convert.typeHierarchyItems
      ),
    provideTypeHierarchySubtypes: (item, token) =>
      request("typeHierarchy/subtypes", { item: convert.toHierarchyItem(item) }, token).then(
        convert.typeHierarchyItems
      ),
  })
  register("registerWorkspaceSymbolProvider", {
    provideWorkspaceSymbols: (query, token) =>
      request("workspace/symbol", { query }, token).then(convert.workspaceSymbols),
    ...(capabilities?.workspaceSymbolProvider?.resolveProvider
      ? {
          resolveWorkspaceSymbol: async (symbol, token) => {
            const original = convert.originOf(symbol)
            if (!original) return symbol
            const resolved = await request("workspaceSymbol/resolve", original, token)
            return resolved ? convert.symbolInformation(resolved) : symbol
          },
        }
      : {}),
  })
  const semanticTokens = capabilities?.semanticTokensProvider
  const legend = semanticTokens?.legend
  if (Array.isArray(legend?.tokenTypes) && Array.isArray(legend?.tokenModifiers)) {
    const codeLegend = new vscode.SemanticTokensLegend(legend.tokenTypes, legend.tokenModifiers)
    if (semanticTokens.full) {
      register(
        "registerDocumentSemanticTokensProvider",
        {
          onDidChangeSemanticTokens: refresh.semanticTokens.event,
          provideDocumentSemanticTokens: (document, token) =>
            request("textDocument/semanticTokens/full", textDocument(document), token).then(
              (value) => reviveSemanticTokens(vscode, value)
            ),
          ...(typeof semanticTokens.full === "object" && semanticTokens.full.delta
            ? {
                provideDocumentSemanticTokensEdits: (document, previousResultId, token) =>
                  request(
                    "textDocument/semanticTokens/full/delta",
                    { ...textDocument(document), previousResultId },
                    token
                  ).then((value) => reviveSemanticTokens(vscode, value)),
              }
            : {}),
        },
        codeLegend
      )
    }
    if (semanticTokens.range) {
      register(
        "registerDocumentRangeSemanticTokensProvider",
        {
          onDidChangeSemanticTokens: refresh.semanticTokens.event,
          provideDocumentRangeSemanticTokens: (document, range, token) =>
            request(
              "textDocument/semanticTokens/range",
              { ...textDocument(document), range: convert.toRange(range) },
              token
            ).then((value) => reviveSemanticTokens(vscode, value)),
        },
        codeLegend
      )
    }
  }

  const diagnostics = vscode.languages.createDiagnosticCollection(server.id)
  registrations.push(diagnostics)
  // Pull diagnostics. VS Code's stable API has no pull-diagnostic provider, so
  // the client pulls (as VS Code's own language client does) on open, change
  // and `workspace/diagnostic/refresh`, into the same collection pushes use.
  const pull = claims(capabilities ?? {}, "diagnosticProvider")
    ? createDiagnosticPuller({
        vscode,
        convert,
        request,
        diagnostics,
        server: capabilities.diagnosticProvider,
      })
    : null
  if (pull)
    registrations.push(
      pull,
      refresh.diagnostic.event(() => pull.refreshAll())
    )
  registrations.push(
    broker.onEvent((message) => {
      if (message?.providerId !== server.id || message?.consumerId !== consumerId) return
      if (message.event === "diagnostics" && typeof message.payload?.uri === "string") {
        diagnostics.set(
          vscode.Uri.parse(message.payload.uri),
          (message.payload.diagnostics ?? []).map(convert.diagnostic)
        )
        return
      }
      if (message.event === "serverRequest") {
        void handleLspServerRequest({
          vscode,
          message: message.payload,
          request,
          refresh,
          progress,
        })
        return
      }
      if (message.event === "serverNotification") {
        void handleLspServerNotification({
          vscode,
          message: message.payload,
          request,
          progress,
        })
      }
    })
  )

  const opened = new Set()
  const matches = (document) =>
    document.uri.scheme === "file" &&
    (!server.languages?.length || server.languages.includes(document.languageId))
  const open = async (document) => {
    if (!matches(document)) return
    const uri = document.uri.toString()
    opened.add(uri)
    await broker.documentProtocol(
      "lsp",
      server,
      ticket,
      {
        operation: "open",
        uri,
        languageId: document.languageId,
        text: document.getText(),
      },
      consumerId
    )
    pull?.document(document)
  }
  const change = async (document) => {
    if (!matches(document)) return
    const uri = document.uri.toString()
    if (!opened.has(uri)) return open(document)
    await broker.documentProtocol(
      "lsp",
      server,
      ticket,
      {
        operation: "change",
        uri,
        text: document.getText(),
      },
      consumerId
    )
    pull?.changed(document)
  }
  const close = async (document) => {
    const uri = document.uri.toString()
    if (!opened.delete(uri)) return
    pull?.forget(document)
    await broker.documentProtocol("lsp", server, ticket, { operation: "close", uri }, consumerId)
  }
  await Promise.all(vscode.workspace.textDocuments.map(open))
  registrations.push(
    vscode.workspace.onDidOpenTextDocument((document) => void open(document)),
    vscode.workspace.onDidChangeTextDocument((event) => void change(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => void close(document))
  )

  return {
    dispose() {
      for (const registration of registrations.splice(0).reverse()) registration.dispose()
      progress.dispose()
      void broker.stopProtocol("lsp", server, ticket, consumerId)
    },
  }
}

/** How long a burst of edits settles before the next diagnostic pull. */
export const DIAGNOSTIC_PULL_DEBOUNCE_MS = 250

/**
 * The client half of LSP pull diagnostics for the documents it has opened.
 *
 * Each pull sends the last `resultId` the server gave for that document, so
 * an `unchanged` report keeps what is shown. A server with
 * `interFileDependencies` has every open document re-pulled when one changes.
 */
export function createDiagnosticPuller({
  vscode,
  convert,
  request,
  diagnostics,
  server,
  debounceMs = DIAGNOSTIC_PULL_DEBOUNCE_MS,
}) {
  const documents = new Map()
  const resultIds = new Map()
  const timers = new Map()
  let disposed = false

  async function pullNow(document) {
    const uri = document.uri.toString()
    if (disposed || !documents.has(uri)) return
    let report
    try {
      report = await request("textDocument/diagnostic", {
        textDocument: { uri },
        ...(server?.identifier ? { identifier: server.identifier } : {}),
        ...(resultIds.has(uri) ? { previousResultId: resultIds.get(uri) } : {}),
      })
    } catch {
      // A failed pull keeps what is shown; the next change pulls again.
      return
    }
    if (disposed || !documents.has(uri) || !report) return
    if (report.resultId) resultIds.set(uri, report.resultId)
    if (report.kind === "full") {
      diagnostics.set(document.uri, (report.items ?? []).map(convert.diagnostic))
    }
    for (const [related, entry] of Object.entries(report.relatedDocuments ?? {})) {
      if (entry?.kind === "full") {
        diagnostics.set(vscode.Uri.parse(related), (entry.items ?? []).map(convert.diagnostic))
      }
      if (entry?.resultId) resultIds.set(related, entry.resultId)
    }
  }

  function schedule(document) {
    const uri = document.uri.toString()
    clearTimeout(timers.get(uri))
    timers.set(
      uri,
      setTimeout(() => {
        timers.delete(uri)
        void pullNow(document)
      }, debounceMs)
    )
  }

  return {
    /** A document was opened: pull at once. */
    document(document) {
      documents.set(document.uri.toString(), document)
      return pullNow(document)
    },
    /** A document changed: pull it (or every open one) once edits settle. */
    changed(document) {
      if (server?.interFileDependencies) {
        for (const entry of documents.values()) schedule(entry)
      } else {
        schedule(document)
      }
    },
    forget(document) {
      const uri = document.uri.toString()
      documents.delete(uri)
      resultIds.delete(uri)
      clearTimeout(timers.get(uri))
      timers.delete(uri)
      diagnostics.delete?.(document.uri)
    },
    /** `workspace/diagnostic/refresh`: the server wants everything pulled again. */
    refreshAll() {
      return Promise.all([...documents.values()].map(pullNow))
    },
    dispose() {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

function reviveSemanticTokens(vscode, value) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value.edits)) {
    return new vscode.SemanticTokensEdits(
      value.edits.map(
        (edit) =>
          new vscode.SemanticTokensEdit(
            edit.start,
            edit.deleteCount,
            Array.isArray(edit.data) ? Uint32Array.from(edit.data) : undefined
          )
      ),
      value.resultId
    )
  }
  return new vscode.SemanticTokens(
    Uint32Array.from(Array.isArray(value.data) ? value.data : []),
    value.resultId
  )
}

async function registerDap(vscode, server, broker) {
  if (typeof vscode.debug?.registerDebugAdapterDescriptorFactory !== "function") {
    throw compatibilityError(
      "IDE_CODE_API_UNAVAILABLE",
      "Code 1.128 debug.registerDebugAdapterDescriptorFactory"
    )
  }
  const active = new Set()
  const sessionsById = new Map()
  const registration = vscode.debug.registerDebugAdapterDescriptorFactory(server.id, {
    async createDebugAdapterDescriptor(debugSession) {
      const consumerId = debugSession.id
      const started = await broker.startProtocol("dap", server, consumerId)
      const ticket = started.capabilityTicket
      const endpoint = started.connection?.endpoint
      if (endpoint) {
        const uri = new URL(endpoint)
        const descriptor = new vscode.DebugAdapterServer(Number(uri.port), uri.hostname)
        const session = {
          ticket,
          disposed: false,
          dispose() {
            if (session.disposed) return
            session.disposed = true
            active.delete(session)
            sessionsById.delete(consumerId)
            void broker.stopProtocol("dap", server, ticket, consumerId)
          },
        }
        active.add(session)
        sessionsById.set(consumerId, session)
        return descriptor
      }
      const emitter = new vscode.EventEmitter()
      const events = broker.onEvent((message) => {
        if (
          message?.providerId !== server.id ||
          message?.consumerId !== consumerId ||
          message.event !== "message"
        )
          return
        emitter.fire(message.payload?.message)
      })
      const session = {
        ticket,
        disposed: false,
        dispose() {
          if (session.disposed) return
          session.disposed = true
          events.dispose()
          emitter.dispose()
          active.delete(session)
          sessionsById.delete(consumerId)
          void broker.stopProtocol("dap", server, ticket, consumerId)
        },
      }
      active.add(session)
      sessionsById.set(consumerId, session)
      return new vscode.DebugAdapterInlineImplementation({
        onDidSendMessage: emitter.event,
        async handleMessage(message) {
          const response = await broker.requestProtocol(
            "dap",
            server,
            ticket,
            "message",
            plain(message),
            undefined,
            consumerId
          )
          if (response) emitter.fire(response)
        },
        dispose: () => session.dispose(),
      })
    },
  })
  const termination = vscode.debug.onDidTerminateDebugSession((debugSession) => {
    sessionsById.get(debugSession.id)?.dispose()
  })
  return {
    dispose() {
      termination.dispose()
      registration.dispose()
      for (const session of [...active]) {
        session.dispose()
      }
      active.clear()
    },
  }
}

async function registerMcp(vscode, server, broker) {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") {
    throw compatibilityError(
      "IDE_CODE_API_UNAVAILABLE",
      "Code 1.128 lm.registerMcpServerDefinitionProvider"
    )
  }
  let active
  const consumerId = "pro-ide"
  const definitions = {
    async provideMcpServerDefinitions() {
      active ??= await broker.startProtocol("mcp", server, consumerId)
      const endpoint = active.connection?.endpoint
      if (!endpoint) {
        throw compatibilityError(
          "IDE_MCP_ENDPOINT_UNAVAILABLE",
          `MCP server ${server.id} did not expose a supervised endpoint`
        )
      }
      return [
        new vscode.McpHttpServerDefinition(
          server.id,
          vscode.Uri.parse(endpoint),
          active.connection?.headers ?? {},
          active.sessionId
        ),
      ]
    },
    resolveMcpServerDefinition(definition) {
      return definition
    },
  }
  const registration = vscode.lm.registerMcpServerDefinitionProvider(server.id, definitions)
  probe.track("mcpProvider", server.id, definitions)
  return {
    dispose() {
      registration.dispose()
      if (active?.capabilityTicket) {
        void broker.stopProtocol("mcp", server, active.capabilityTicket, consumerId)
      }
      active = undefined
    },
  }
}

function createRefreshEmitter(vscode, registrations) {
  const emitter = new vscode.EventEmitter()
  registrations.push(emitter)
  return {
    event: emitter.event,
    fire: () => emitter.fire(undefined),
  }
}

function createWorkDoneProgress(vscode, request) {
  const sessions = new Map()
  const tokenKey = (token) => JSON.stringify(token)
  return {
    create(_token) {
      return null
    },
    update(params) {
      const key = tokenKey(params?.token)
      const value = params?.value
      if (!value || typeof value !== "object") return
      if (value.kind === "begin") {
        sessions.get(key)?.resolve?.()
        const state = { reporter: null, queued: [], resolve: null }
        sessions.set(key, state)
        void vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: String(value.title ?? ""),
            cancellable: value.cancellable === true,
          },
          (reporter, cancellationToken) => {
            state.reporter = reporter
            for (const item of state.queued.splice(0)) reporter.report(item)
            cancellationToken.onCancellationRequested(() => {
              void request("$/cognia/clientNotification", {
                method: "window/workDoneProgress/cancel",
                payload: { token: params.token },
              })
            })
            return new Promise((resolve) => {
              state.resolve = resolve
            })
          }
        )
        if (value.message || typeof value.percentage === "number") {
          reportProgress(state, value)
        }
        return
      }
      const state = sessions.get(key)
      if (!state) return
      if (value.kind === "report") {
        reportProgress(state, value)
      } else if (value.kind === "end") {
        if (value.message) reportProgress(state, value)
        state.resolve?.()
        sessions.delete(key)
      }
    },
    dispose() {
      for (const state of sessions.values()) state.resolve?.()
      sessions.clear()
    },
  }
}

function reportProgress(state, value) {
  const report = {
    ...(typeof value.percentage === "number" ? { increment: value.percentage } : {}),
    ...(value.message ? { message: String(value.message) } : {}),
  }
  if (state.reporter) state.reporter.report(report)
  else state.queued.push(report)
}

async function handleLspServerRequest({ vscode, message, request, refresh, progress }) {
  if (!message || typeof message.requestId !== "string" || typeof message.method !== "string") {
    return
  }
  let response
  try {
    await request("$/cognia/authorizeServerRequest", {
      requestId: message.requestId,
      method: message.method,
    })
    response = {
      result: await projectLspServerRequest(vscode, message, refresh, progress),
    }
  } catch (error) {
    response = {
      error: {
        code: Number.isInteger(error?.code) ? error.code : -32002,
        message: error instanceof Error ? error.message : String(error),
        ...(error?.data === undefined ? {} : { data: plain(error.data) }),
      },
    }
  }
  await request("$/cognia/serverResponse", {
    requestId: message.requestId,
    ...response,
  })
}

async function projectLspServerRequest(vscode, message, refresh, progress) {
  const params = message.payload ?? {}
  switch (message.method) {
    case "workspace/applyEdit":
      return applyLspWorkspaceEdit(vscode, params, message.preconditions ?? {})
    case "workspace/workspaceFolders":
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        uri: folder.uri.toString(),
        name: folder.name,
      }))
    case "workspace/semanticTokens/refresh":
      refresh.semanticTokens.fire()
      return null
    case "workspace/codeLens/refresh":
      refresh.codeLens.fire()
      return null
    case "workspace/inlayHint/refresh":
      refresh.inlayHint.fire()
      return null
    case "workspace/inlineValue/refresh":
      refresh.inlineValue.fire()
      return null
    case "workspace/diagnostic/refresh":
      refresh.diagnostic.fire()
      return null
    case "workspace/foldingRange/refresh":
      refresh.foldingRange.fire()
      return null
    case "window/showMessageRequest":
      return showMessageRequest(vscode, params)
    case "window/showDocument":
      return showDocument(vscode, params)
    case "window/workDoneProgress/create":
      return progress.create(params.token)
    case "client/registerCapability":
    case "client/unregisterCapability":
      throw compatibilityError(
        "IDE_LSP_DYNAMIC_REGISTRATION_UNSUPPORTED",
        "dynamicRegistration was explicitly advertised as false"
      )
    default:
      throw compatibilityError("IDE_LSP_CLIENT_METHOD_UNSUPPORTED", message.method)
  }
}

async function handleLspServerNotification({ vscode, message, progress }) {
  if (!message || typeof message.method !== "string") return
  const params = message.payload ?? {}
  switch (message.method) {
    case "$/progress":
      progress.update(params)
      return
    case "window/showMessage":
      await showMessage(vscode, params)
      return
    case "window/logMessage":
    case "$/logTrace":
    case "telemetry/event":
      return
    default:
      throw compatibilityError("IDE_LSP_CLIENT_NOTIFICATION_UNSUPPORTED", message.method)
  }
}

async function showMessageRequest(vscode, params) {
  const actions = Array.isArray(params.actions) ? params.actions : []
  const titles = actions.map((action) => String(action.title ?? ""))
  const selected = await showMessage(vscode, params, ...titles)
  if (typeof selected !== "string") return null
  return actions.find((action) => action.title === selected) ?? { title: selected }
}

function showMessage(vscode, params, ...actions) {
  const message = String(params.message ?? "")
  const options = { modal: false }
  if (params.type === 1) return vscode.window.showErrorMessage(message, options, ...actions)
  if (params.type === 2) return vscode.window.showWarningMessage(message, options, ...actions)
  return vscode.window.showInformationMessage(message, options, ...actions)
}

async function showDocument(vscode, params) {
  if (typeof params.uri !== "string") {
    throw compatibilityError("IDE_LSP_SHOW_DOCUMENT_URI_REQUIRED", "uri")
  }
  const uri = vscode.Uri.parse(params.uri)
  if (params.external === true) {
    return { success: await vscode.env.openExternal(uri) }
  }
  const selection = params.selection ? reviveRange(vscode, params.selection) : undefined
  await vscode.window.showTextDocument(uri, {
    preview: false,
    preserveFocus: params.takeFocus === false,
    ...(selection ? { selection } : {}),
  })
  return { success: true }
}

export async function applyLspWorkspaceEdit(vscode, params, preconditions) {
  if (!params.edit || typeof params.edit !== "object") {
    throw compatibilityError("IDE_LSP_WORKSPACE_EDIT_REQUIRED", "edit")
  }
  const uris = workspaceEditUris(params.edit)
  for (const uri of uris) {
    await assertWorkspaceUri(uri)
    await verifyEditPrecondition(vscode, uri, preconditions[uri])
  }
  const applied = await vscode.workspace.applyEdit(reviveWorkspaceEdit(vscode, params.edit))
  return {
    applied,
    ...(applied ? {} : { failureReason: "IDE_WORKSPACE_EDIT_REJECTED" }),
  }
}

function workspaceEditUris(edit) {
  const uris = new Set(Object.keys(edit.changes ?? {}))
  for (const change of edit.documentChanges ?? []) {
    for (const uri of [change?.textDocument?.uri, change?.uri, change?.oldUri, change?.newUri]) {
      if (typeof uri === "string") uris.add(uri)
    }
  }
  return uris
}

async function assertWorkspaceUri(uriString) {
  let target
  try {
    target = fileURLToPath(uriString)
  } catch {
    throw compatibilityError("IDE_FILE_URI_INVALID", uriString)
  }
  const root = process.env.COGNIA_CS_WORKSPACE
  if (!root || !isAbsolute(root)) {
    throw compatibilityError("IDE_WORKSPACE_ROOT_UNAVAILABLE", root ?? "")
  }
  const canonicalRoot = await realpath(root)
  const canonicalTarget = await canonicalizePotentialPath(target)
  const rel = relative(canonicalRoot, canonicalTarget)
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw compatibilityError("IDE_PATH_OUTSIDE_WORKSPACE", uriString)
  }
}

async function canonicalizePotentialPath(target) {
  let cursor = target
  const suffix = []
  while (true) {
    try {
      const base = await realpath(cursor)
      return suffix.reduce((value, part) => `${value}/${part}`, base)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]/, ""))
      cursor = parent
    }
  }
}

async function verifyEditPrecondition(vscode, uriString, precondition) {
  if (!precondition || typeof precondition !== "object") {
    throw compatibilityError("IDE_WORKSPACE_EDIT_PRECONDITION_REQUIRED", uriString)
  }
  const uri = vscode.Uri.parse(uriString)
  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === uriString
  )
  if (precondition.exists === false) {
    try {
      await stat(fileURLToPath(uriString))
      throw compatibilityError("IDE_WORKSPACE_EDIT_CONFLICT", `${uriString}: expected absent`)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    return
  }
  if (typeof precondition.contentHash !== "string") {
    throw compatibilityError("IDE_WORKSPACE_EDIT_CONTENT_HASH_REQUIRED", uriString)
  }
  if (
    typeof precondition.version === "number" &&
    (!openDocument || openDocument.version !== precondition.version)
  ) {
    throw compatibilityError("IDE_WORKSPACE_EDIT_VERSION_CONFLICT", uriString)
  }
  const bytes = openDocument
    ? Buffer.from(openDocument.getText(), "utf8")
    : Buffer.from(await vscode.workspace.fs.readFile(uri))
  const currentHash = createHash("sha256").update(bytes).digest("hex")
  if (currentHash !== precondition.contentHash) {
    throw compatibilityError("IDE_WORKSPACE_EDIT_CONTENT_CONFLICT", uriString)
  }
}

function plain(value) {
  if (value == null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value.toJSON === "function") return plain(value.toJSON())
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry !== "function")
      .map(([key, entry]) => [key, plain(entry)])
  )
}

function reviveWorkspaceEdit(vscode, value) {
  if (!value || typeof value !== "object") return value
  const edit = new vscode.WorkspaceEdit()
  const annotations = value.changeAnnotations ?? {}
  const metadata = (annotationId) => {
    const annotation = annotations[annotationId]
    if (!annotation) return undefined
    return {
      label: String(annotation.label ?? ""),
      needsConfirmation: annotation.needsConfirmation === true,
      description: typeof annotation.description === "string" ? annotation.description : undefined,
    }
  }
  const reviveTextEdits = (changes) =>
    changes.map((change) => {
      const textEdit = vscode.TextEdit.replace(
        reviveRange(vscode, change.range),
        String(change.newText ?? "")
      )
      const entryMetadata = metadata(change.annotationId)
      return entryMetadata ? [textEdit, entryMetadata] : textEdit
    })
  for (const [uri, changes] of Object.entries(value.changes ?? {})) {
    edit.set(vscode.Uri.parse(uri), reviveTextEdits(changes))
  }
  for (const change of value.documentChanges ?? []) {
    if (change?.textDocument?.uri && Array.isArray(change.edits)) {
      edit.set(vscode.Uri.parse(change.textDocument.uri), reviveTextEdits(change.edits))
      continue
    }
    const entryMetadata = metadata(change?.annotationId)
    if (change?.kind === "create" && typeof change.uri === "string") {
      edit.createFile(vscode.Uri.parse(change.uri), change.options, entryMetadata)
    } else if (
      change?.kind === "rename" &&
      typeof change.oldUri === "string" &&
      typeof change.newUri === "string"
    ) {
      edit.renameFile(
        vscode.Uri.parse(change.oldUri),
        vscode.Uri.parse(change.newUri),
        change.options,
        entryMetadata
      )
    } else if (change?.kind === "delete" && typeof change.uri === "string") {
      edit.deleteFile(vscode.Uri.parse(change.uri), change.options, entryMetadata)
    }
  }
  return edit
}

function reviveRange(vscode, value) {
  return new vscode.Range(
    value?.start?.line ?? 0,
    value?.start?.character ?? 0,
    value?.end?.line ?? 0,
    value?.end?.character ?? 0
  )
}

function combine(vscode, ...disposables) {
  if (vscode.Disposable?.from) return vscode.Disposable.from(...disposables)
  return {
    dispose() {
      for (const disposable of disposables.reverse()) disposable.dispose()
    },
  }
}

function compatibilityError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}
