/**
 * Stable Code 1.128 provider adapters for generated Cognia proxy extensions.
 *
 * Plugin code never runs here. Every callback serializes the VS Code values and
 * invokes the single Cognia-owned runtime through the managed broker.
 */

export const PROVIDER_ADAPTER_KINDS = Object.freeze([
  "command",
  "completion",
  "hover",
  "definition",
  "declaration",
  "type-definition",
  "implementation",
  "references",
  "document-highlight",
  "document-symbol",
  "workspace-symbol",
  "code-action",
  "code-lens",
  "document-link",
  "document-color",
  "format-document",
  "format-range",
  "format-on-type",
  "rename",
  "folding-range",
  "selection-range",
  "signature-help",
  "semantic-tokens-document",
  "semantic-tokens-range",
  "inline-completion",
  "inline-values",
  "inlay-hints",
  "linked-editing-range",
  "call-hierarchy",
  "type-hierarchy",
  "evaluatable-expression",
  "document-drop-edit",
  "document-paste-edit",
  "text-document-content",
  "file-system",
  "tree-data",
  "status-bar-item",
  "text-editor-decoration",
  "file-decoration",
  "language-status-item",
  "webview-view",
  "custom-editor",
  "webview-panel-serializer",
  "terminal-profile",
  "terminal-link",
  "task",
  "source-control",
  "debug-configuration",
  "debug-adapter",
  "debug-tracker",
  "test-controller",
  "notebook-serializer",
  "notebook-controller",
  "notebook-cell-status-bar",
  "comment-controller",
  "authentication",
  "uri-handler",
  "chat-participant",
  "language-model-chat-provider",
  "language-model-tool",
  "mcp-server-definition",
])

export async function registerManagedProviders(vscode, descriptor, broker) {
  validateDescriptor(descriptor)
  const registrations = []
  try {
    for (const provider of descriptor.providers ?? []) {
      const adapter = ADAPTERS[provider.kind]
      if (!adapter) {
        throw compatibilityError(
          "IDE_PROVIDER_UNCLASSIFIED",
          `No Code 1.128 adapter for provider kind ${provider.kind}`
        )
      }
      const disposable = await adapter(vscode, provider, broker)
      if (!disposable || typeof disposable.dispose !== "function") {
        throw compatibilityError(
          "IDE_PROVIDER_REGISTRATION_FAILED",
          `Provider ${provider.id} did not return a disposable registration`
        )
      }
      registrations.push(disposable)
    }
  } catch (error) {
    for (const registration of registrations.reverse()) registration.dispose()
    throw error
  }
  return {
    dispose() {
      for (const registration of registrations.splice(0).reverse()) registration.dispose()
    },
  }
}

async function invoke(broker, provider, operation, args, token) {
  const serialized = await Promise.all(
    args.map((value) => serializeBrokerValue(value, broker, provider))
  )
  const value = await broker.invoke(provider, operation, serialized, token)
  return reviveBrokerValue(value, broker, provider)
}

async function invokeStreaming(vscode, broker, provider, operation, args, token, handlers) {
  if (typeof broker.createInvocationId !== "function" || typeof broker.onEvent !== "function") {
    throw compatibilityError(
      "IDE_STREAMING_BROKER_UNAVAILABLE",
      `${provider.kind} requires correlated managed broker events`
    )
  }
  const serialized = await Promise.all(
    args.map((value) => serializeBrokerValue(value, broker, provider))
  )
  const invocationId = broker.createInvocationId()
  const events = providerEvents(
    broker,
    provider,
    {
      ...handlers,
      approval: (payload) => projectAgentApproval(vscode, broker, provider, invocationId, payload),
    },
    invocationId
  )
  try {
    const value = await broker.invoke(provider, operation, serialized, token, invocationId)
    return reviveBrokerValue(value, broker, provider)
  } finally {
    events.dispose()
  }
}

function language(_unused, method, methods, extra = () => []) {
  return async (vscode, provider, broker) => {
    requireApi(vscode.languages, method, provider)
    const implementation = Object.fromEntries(
      methods.map(([name, operation]) => [
        name,
        (...args) => invoke(broker, provider, operation, args, cancellationToken(args)),
      ])
    )
    return vscode.languages[method](provider.selector ?? "*", implementation, ...extra(provider))
  }
}

const ADAPTERS = {
  command: async (vscode, provider, broker) => {
    requireApi(vscode.commands, "registerCommand", provider)
    return vscode.commands.registerCommand(provider.id, (...args) =>
      invoke(broker, provider, "execute", args)
    )
  },
  completion: language(
    null,
    "registerCompletionItemProvider",
    [["provideCompletionItems", "provide"]],
    (provider) => provider.metadata?.triggerCharacters ?? []
  ),
  hover: language(null, "registerHoverProvider", [["provideHover", "provide"]]),
  definition: language(null, "registerDefinitionProvider", [["provideDefinition", "provide"]]),
  declaration: language(null, "registerDeclarationProvider", [["provideDeclaration", "provide"]]),
  "type-definition": language(null, "registerTypeDefinitionProvider", [
    ["provideTypeDefinition", "provide"],
  ]),
  implementation: language(null, "registerImplementationProvider", [
    ["provideImplementation", "provide"],
  ]),
  references: language(null, "registerReferenceProvider", [["provideReferences", "provide"]]),
  "document-highlight": language(null, "registerDocumentHighlightProvider", [
    ["provideDocumentHighlights", "provide"],
  ]),
  "document-symbol": language(null, "registerDocumentSymbolProvider", [
    ["provideDocumentSymbols", "provide"],
  ]),
  "workspace-symbol": language(null, "registerWorkspaceSymbolProvider", [
    ["provideWorkspaceSymbols", "provide"],
    ["resolveWorkspaceSymbol", "resolve"],
  ]),
  "code-action": language(
    null,
    "registerCodeActionsProvider",
    [["provideCodeActions", "provide"]],
    (provider) => [provider.metadata?.registrationMetadata]
  ),
  "code-lens": language(null, "registerCodeLensProvider", [
    ["provideCodeLenses", "provide"],
    ["resolveCodeLens", "resolve"],
  ]),
  "document-link": language(null, "registerDocumentLinkProvider", [
    ["provideDocumentLinks", "provide"],
    ["resolveDocumentLink", "resolve"],
  ]),
  "document-color": language(null, "registerColorProvider", [
    ["provideDocumentColors", "provideColors"],
    ["provideColorPresentations", "providePresentations"],
  ]),
  "format-document": language(null, "registerDocumentFormattingEditProvider", [
    ["provideDocumentFormattingEdits", "provide"],
  ]),
  "format-range": language(null, "registerDocumentRangeFormattingEditProvider", [
    ["provideDocumentRangeFormattingEdits", "provide"],
  ]),
  "format-on-type": language(
    null,
    "registerOnTypeFormattingEditProvider",
    [["provideOnTypeFormattingEdits", "provide"]],
    (provider) => [
      String(provider.metadata?.firstTriggerCharacter ?? ""),
      ...(provider.metadata?.moreTriggerCharacters ?? []),
    ]
  ),
  rename: language(null, "registerRenameProvider", [
    ["provideRenameEdits", "provide"],
    ["prepareRename", "prepare"],
  ]),
  "folding-range": language(null, "registerFoldingRangeProvider", [
    ["provideFoldingRanges", "provide"],
  ]),
  "selection-range": language(null, "registerSelectionRangeProvider", [
    ["provideSelectionRanges", "provide"],
  ]),
  "signature-help": language(
    null,
    "registerSignatureHelpProvider",
    [["provideSignatureHelp", "provide"]],
    (provider) => [provider.metadata?.registrationMetadata ?? {}]
  ),
  "semantic-tokens-document": async (vscode, provider, broker) => {
    requireApi(vscode.languages, "registerDocumentSemanticTokensProvider", provider)
    const legend = new vscode.SemanticTokensLegend(
      provider.metadata?.tokenTypes ?? [],
      provider.metadata?.tokenModifiers ?? []
    )
    return vscode.languages.registerDocumentSemanticTokensProvider(
      provider.selector ?? "*",
      {
        provideDocumentSemanticTokens: (...args) =>
          invoke(broker, provider, "provide", args, cancellationToken(args)),
        provideDocumentSemanticTokensEdits: (...args) =>
          invoke(broker, provider, "provideEdits", args, cancellationToken(args)),
      },
      legend
    )
  },
  "semantic-tokens-range": async (vscode, provider, broker) => {
    requireApi(vscode.languages, "registerDocumentRangeSemanticTokensProvider", provider)
    const legend = new vscode.SemanticTokensLegend(
      provider.metadata?.tokenTypes ?? [],
      provider.metadata?.tokenModifiers ?? []
    )
    return vscode.languages.registerDocumentRangeSemanticTokensProvider(
      provider.selector ?? "*",
      {
        provideDocumentRangeSemanticTokens: (...args) =>
          invoke(broker, provider, "provide", args, cancellationToken(args)),
      },
      legend
    )
  },
  "inline-completion": language(null, "registerInlineCompletionItemProvider", [
    ["provideInlineCompletionItems", "provide"],
  ]),
  "inline-values": language(null, "registerInlineValuesProvider", [
    ["provideInlineValues", "provide"],
  ]),
  "inlay-hints": language(null, "registerInlayHintsProvider", [
    ["provideInlayHints", "provide"],
    ["resolveInlayHint", "resolve"],
  ]),
  "linked-editing-range": language(null, "registerLinkedEditingRangeProvider", [
    ["provideLinkedEditingRanges", "provide"],
  ]),
  "call-hierarchy": language(null, "registerCallHierarchyProvider", [
    ["prepareCallHierarchy", "prepare"],
    ["provideCallHierarchyIncomingCalls", "incoming"],
    ["provideCallHierarchyOutgoingCalls", "outgoing"],
  ]),
  "type-hierarchy": language(null, "registerTypeHierarchyProvider", [
    ["prepareTypeHierarchy", "prepare"],
    ["provideTypeHierarchySupertypes", "supertypes"],
    ["provideTypeHierarchySubtypes", "subtypes"],
  ]),
  "evaluatable-expression": language(null, "registerEvaluatableExpressionProvider", [
    ["provideEvaluatableExpression", "provide"],
  ]),
  "document-drop-edit": language(
    null,
    "registerDocumentDropEditProvider",
    [
      ["provideDocumentDropEdits", "provide"],
      ["resolveDocumentDropEdit", "resolve"],
    ],
    (provider) => [provider.metadata?.registrationMetadata]
  ),
  "document-paste-edit": async (vscode, provider, broker) => {
    requireApi(vscode.languages, "registerDocumentPasteEditProvider", provider)
    return vscode.languages.registerDocumentPasteEditProvider(
      provider.selector ?? "*",
      {
        async prepareDocumentPaste(document, ranges, dataTransfer, token) {
          const result = await invoke(
            broker,
            provider,
            "prepare",
            [document, ranges, dataTransfer],
            token
          )
          applyPreparedDataTransfer(vscode, dataTransfer, result)
        },
        provideDocumentPasteEdits: (...args) =>
          invoke(broker, provider, "provide", args, cancellationToken(args)),
        resolveDocumentPasteEdit: (...args) =>
          invoke(broker, provider, "resolve", args, cancellationToken(args)),
      },
      provider.metadata?.registrationMetadata ?? {}
    )
  },
  "text-document-content": async (vscode, provider, broker) => {
    requireApi(vscode.workspace, "registerTextDocumentContentProvider", provider)
    const emitter = new vscode.EventEmitter()
    const registration = vscode.workspace.registerTextDocumentContentProvider(
      requiredMetadata(provider, "scheme"),
      {
        onDidChange: emitter.event,
        provideTextDocumentContent: (...args) =>
          invoke(broker, provider, "provide", args, cancellationToken(args)),
      }
    )
    const events = providerEvents(broker, provider, {
      change: (payload) => emitter.fire(reviveValue(payload?.uri ?? payload, provider)),
    })
    return combine(vscode, emitter, registration, events)
  },
  "file-system": async (vscode, provider, broker) => {
    requireApi(vscode.workspace, "registerFileSystemProvider", provider)
    const emitter = new vscode.EventEmitter()
    const fsProvider = {
      onDidChangeFile: emitter.event,
      watch: (...args) => remoteDisposable(vscode, broker, provider, "watch", args),
      stat: (...args) => invoke(broker, provider, "stat", args),
      readDirectory: (...args) => invoke(broker, provider, "readDirectory", args),
      createDirectory: (...args) => invoke(broker, provider, "createDirectory", args),
      readFile: (...args) => invoke(broker, provider, "readFile", args).then(ensureBytes),
      writeFile: (...args) => invoke(broker, provider, "writeFile", args),
      delete: (...args) => invoke(broker, provider, "delete", args),
      rename: (...args) => invoke(broker, provider, "rename", args),
      copy: (...args) => invoke(broker, provider, "copy", args),
    }
    const registration = vscode.workspace.registerFileSystemProvider(
      requiredMetadata(provider, "scheme"),
      fsProvider,
      provider.metadata?.options
    )
    const events = providerEvents(broker, provider, {
      change: (payload) => emitter.fire(reviveValue(payload?.events ?? payload, provider)),
    })
    return combine(vscode, emitter, registration, events)
  },
  "tree-data": async (vscode, provider, broker) => {
    requireApi(vscode.window, "createTreeView", provider)
    const emitter = new vscode.EventEmitter()
    const dataProvider = {
      onDidChangeTreeData: emitter.event,
      getTreeItem: (item) => invoke(broker, provider, "getTreeItem", [item]),
      getChildren: (item) => invoke(broker, provider, "getChildren", [item]),
      getParent: (item) => invoke(broker, provider, "getParent", [item]),
      resolveTreeItem: (...args) =>
        invoke(broker, provider, "resolveTreeItem", args, cancellationToken(args)),
    }
    const view = vscode.window.createTreeView(provider.id, {
      treeDataProvider: dataProvider,
      ...(provider.metadata?.options ?? {}),
    })
    const events = providerEvents(broker, provider, {
      change: (payload) => emitter.fire(reviveValue(payload?.item, provider)),
    })
    return combine(vscode, emitter, view, events)
  },
  "status-bar-item": async (vscode, provider, broker) => {
    requireApi(vscode.window, "createStatusBarItem", provider)
    const alignment =
      provider.metadata?.alignment === "right"
        ? vscode.StatusBarAlignment.Right
        : vscode.StatusBarAlignment.Left
    const item = vscode.window.createStatusBarItem(
      provider.id,
      alignment,
      Number(provider.metadata?.priority ?? 0)
    )
    const update = (value) => {
      if (!value || typeof value !== "object") return
      for (const key of [
        "name",
        "text",
        "tooltip",
        "color",
        "backgroundColor",
        "command",
        "accessibilityInformation",
      ]) {
        if (Object.hasOwn(value, key)) item[key] = reviveValue(value[key], provider)
      }
      if (value.visible === false) item.hide()
      else item.show()
    }
    update(await invoke(broker, provider, "initialize", []))
    const events = providerEvents(broker, provider, { change: update })
    return combine(vscode, item, events)
  },
  "text-editor-decoration": async (vscode, provider, broker) => {
    requireApi(vscode.window, "createTextEditorDecorationType", provider)
    const decoration = vscode.window.createTextEditorDecorationType(
      provider.metadata?.decorationType ?? {}
    )
    const revisions = new Map()
    const refresh = async (editor) => {
      if (!editor?.document) return
      const key = editor.document.uri.toString()
      const revision = (revisions.get(key) ?? 0) + 1
      revisions.set(key, revision)
      const result = await invoke(broker, provider, "provide", [editor.document])
      if (revisions.get(key) !== revision) return
      const values = (Array.isArray(result) ? result : []).map((entry) => {
        if (entry?.range) {
          return { ...entry, range: reviveRange(vscode, entry.range) }
        }
        return reviveRange(vscode, entry)
      })
      editor.setDecorations(decoration, values)
    }
    const refreshVisible = (uri) =>
      Promise.all(
        (vscode.window.visibleTextEditors ?? [])
          .filter((editor) => !uri || editor.document.uri.toString() === uri)
          .map(refresh)
      )
    await refreshVisible()
    const visible = vscode.window.onDidChangeVisibleTextEditors?.(() => void refreshVisible()) ?? {
      dispose() {},
    }
    const documents = vscode.workspace?.onDidChangeTextDocument?.((event) => {
      void refreshVisible(event.document.uri.toString())
    }) ?? { dispose() {} }
    const events = providerEvents(broker, provider, {
      change: (payload) => void refreshVisible(payload?.uri),
    })
    return combine(vscode, decoration, visible, documents, events)
  },
  "file-decoration": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerFileDecorationProvider", provider)
    const emitter = new vscode.EventEmitter()
    const registration = vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: emitter.event,
      provideFileDecoration: (...args) =>
        invoke(broker, provider, "provide", args, cancellationToken(args)),
    })
    const events = providerEvents(broker, provider, {
      change: (payload) => emitter.fire(reviveValue(payload?.uris ?? payload, provider)),
    })
    return combine(vscode, emitter, registration, events)
  },
  "language-status-item": async (vscode, provider, broker) => {
    requireApi(vscode.languages, "createLanguageStatusItem", provider)
    const item = vscode.languages.createLanguageStatusItem(provider.id, provider.selector ?? "*")
    const update = (value) => {
      if (!value || typeof value !== "object") return
      for (const key of [
        "name",
        "selector",
        "severity",
        "text",
        "detail",
        "busy",
        "command",
        "accessibilityInformation",
      ]) {
        if (Object.hasOwn(value, key)) item[key] = reviveValue(value[key], provider)
      }
    }
    update(await invoke(broker, provider, "initialize", []))
    const events = providerEvents(broker, provider, { change: update })
    return combine(vscode, item, events)
  },
  "webview-view": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerWebviewViewProvider", provider)
    return vscode.window.registerWebviewViewProvider(provider.id, {
      async resolveWebviewView(view, context, token) {
        view.webview.options = {
          enableScripts: provider.metadata?.enableScripts === true,
          localResourceRoots: [],
        }
        const result = await invoke(broker, provider, "resolve", [{ context }], token)
        view.webview.html = validateWebviewHtml(result?.html ?? "")
        view.webview.onDidReceiveMessage((message) =>
          invoke(broker, provider, "message", [message])
        )
      },
    })
  },
  "custom-editor": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerCustomEditorProvider", provider)
    return vscode.window.registerCustomEditorProvider(
      provider.id,
      {
        async resolveCustomTextEditor(document, panel, token) {
          panel.webview.options = {
            enableScripts: provider.metadata?.enableScripts === true,
            localResourceRoots: [],
          }
          const result = await invoke(broker, provider, "resolve", [document], token)
          panel.webview.html = validateWebviewHtml(result?.html ?? "")
          panel.webview.onDidReceiveMessage((message) =>
            invoke(broker, provider, "message", [document, message])
          )
        },
      },
      provider.metadata?.options
    )
  },
  "webview-panel-serializer": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerWebviewPanelSerializer", provider)
    return vscode.window.registerWebviewPanelSerializer(requiredMetadata(provider, "viewType"), {
      async deserializeWebviewPanel(panel, state) {
        panel.webview.options = {
          enableScripts: provider.metadata?.enableScripts === true,
          localResourceRoots: [],
        }
        const result = await invoke(broker, provider, "deserialize", [state])
        panel.webview.html = validateWebviewHtml(result?.html ?? "")
        panel.webview.onDidReceiveMessage((message) =>
          invoke(broker, provider, "message", [state, message])
        )
      },
    })
  },
  "terminal-profile": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerTerminalProfileProvider", provider)
    return vscode.window.registerTerminalProfileProvider(provider.id, {
      async provideTerminalProfile(token) {
        const options = await invoke(broker, provider, "provide", [], token)
        return new vscode.TerminalProfile(options)
      },
    })
  },
  "terminal-link": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerTerminalLinkProvider", provider)
    return vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks: (...args) =>
        invoke(broker, provider, "provide", args, cancellationToken(args)),
      handleTerminalLink: (...args) => invoke(broker, provider, "handle", args),
    })
  },
  task: async (vscode, provider, broker) => {
    requireApi(vscode.tasks, "registerTaskProvider", provider)
    return vscode.tasks.registerTaskProvider(requiredMetadata(provider, "type"), {
      provideTasks: (...args) => invoke(broker, provider, "provide", args),
      resolveTask: (...args) => invoke(broker, provider, "resolve", args, cancellationToken(args)),
    })
  },
  "source-control": async (vscode, provider, broker) => {
    requireApi(vscode.scm, "createSourceControl", provider)
    const scm = vscode.scm.createSourceControl(
      provider.id,
      String(provider.metadata?.label ?? provider.id),
      provider.metadata?.rootUri ? reviveValue(provider.metadata.rootUri, provider) : undefined
    )
    await invoke(broker, provider, "initialize", [])
    return scm
  },
  "debug-configuration": async (vscode, provider, broker) => {
    requireApi(vscode.debug, "registerDebugConfigurationProvider", provider)
    return vscode.debug.registerDebugConfigurationProvider(
      requiredMetadata(provider, "debugType"),
      {
        provideDebugConfigurations: (...args) =>
          invoke(broker, provider, "provide", args, cancellationToken(args)),
        resolveDebugConfiguration: (...args) =>
          invoke(broker, provider, "resolve", args, cancellationToken(args)),
        resolveDebugConfigurationWithSubstitutedVariables: (...args) =>
          invoke(broker, provider, "resolveSubstituted", args, cancellationToken(args)),
      }
    )
  },
  "debug-adapter": async (vscode, provider, broker) => {
    requireApi(vscode.debug, "registerDebugAdapterDescriptorFactory", provider)
    return vscode.debug.registerDebugAdapterDescriptorFactory(
      requiredMetadata(provider, "debugType"),
      {
        createDebugAdapterDescriptor(session) {
          const emitter = new vscode.EventEmitter()
          const implementation = {
            onDidSendMessage: emitter.event,
            handleMessage: (message) =>
              invoke(broker, provider, "handleMessage", [session, message]).then((messages) => {
                for (const response of messages ?? []) emitter.fire(response)
              }),
            dispose: () => {
              void invoke(broker, provider, "dispose", [session])
              emitter.dispose()
            },
          }
          return new vscode.DebugAdapterInlineImplementation(implementation)
        },
      }
    )
  },
  "debug-tracker": async (vscode, provider, broker) => {
    requireApi(vscode.debug, "registerDebugAdapterTrackerFactory", provider)
    return vscode.debug.registerDebugAdapterTrackerFactory(
      requiredMetadata(provider, "debugType"),
      {
        createDebugAdapterTracker: (session) =>
          Object.fromEntries(
            [
              "onWillStartSession",
              "onWillReceiveMessage",
              "onDidSendMessage",
              "onWillStopSession",
              "onError",
              "onExit",
            ].map((operation) => [
              operation,
              (...args) => void invoke(broker, provider, operation, [session, ...args]),
            ])
          ),
      }
    )
  },
  "test-controller": async (vscode, provider, broker) => {
    requireApi(vscode.tests, "createTestController", provider)
    const controller = vscode.tests.createTestController(
      provider.id,
      String(provider.metadata?.label ?? provider.id)
    )
    controller.resolveHandler = async (item) => {
      const definitions = await invoke(broker, provider, "resolve", [item])
      replaceTestItems(vscode, controller, item, definitions ?? [])
    }
    for (const profile of provider.metadata?.runProfiles ?? []) {
      controller.createRunProfile(
        profile.label,
        vscode.TestRunProfileKind[profile.kind] ?? vscode.TestRunProfileKind.Run,
        (request, token) => invoke(broker, provider, "run", [request], token),
        profile.isDefault === true,
        profile.tag ? new vscode.TestTag(profile.tag) : undefined,
        profile.supportsContinuousRun === true
      )
    }
    return controller
  },
  "notebook-serializer": async (vscode, provider, broker) => {
    requireApi(vscode.workspace, "registerNotebookSerializer", provider)
    return vscode.workspace.registerNotebookSerializer(
      requiredMetadata(provider, "notebookType"),
      {
        deserializeNotebook: (content, token) =>
          invoke(broker, provider, "deserialize", [content], token),
        serializeNotebook: (data, token) =>
          invoke(broker, provider, "serialize", [data], token).then(ensureBytes),
      },
      provider.metadata?.options
    )
  },
  "notebook-controller": async (vscode, provider, broker) => {
    requireApi(vscode.notebooks, "createNotebookController", provider)
    const controller = vscode.notebooks.createNotebookController(
      provider.id,
      requiredMetadata(provider, "notebookType"),
      String(provider.metadata?.label ?? provider.id)
    )
    controller.supportedLanguages = provider.metadata?.supportedLanguages
    controller.supportsExecutionOrder = provider.metadata?.supportsExecutionOrder === true
    controller.executeHandler = (cells, notebook) =>
      invoke(broker, provider, "execute", [cells, notebook])
    controller.interruptHandler = (notebook) => invoke(broker, provider, "interrupt", [notebook])
    return controller
  },
  "notebook-cell-status-bar": async (vscode, provider, broker) => {
    requireApi(vscode.notebooks, "registerNotebookCellStatusBarItemProvider", provider)
    return vscode.notebooks.registerNotebookCellStatusBarItemProvider(
      requiredMetadata(provider, "notebookType"),
      {
        provideCellStatusBarItems: (...args) =>
          invoke(broker, provider, "provide", args, cancellationToken(args)),
      }
    )
  },
  "comment-controller": async (vscode, provider, broker) => {
    requireApi(vscode.comments, "createCommentController", provider)
    const controller = vscode.comments.createCommentController(
      provider.id,
      String(provider.metadata?.label ?? provider.id)
    )
    await invoke(broker, provider, "initialize", [])
    return controller
  },
  authentication: async (vscode, provider, broker) => {
    requireApi(vscode.authentication, "registerAuthenticationProvider", provider)
    const emitter = new vscode.EventEmitter()
    const registration = vscode.authentication.registerAuthenticationProvider(
      requiredMetadata(provider, "authenticationProviderId"),
      String(provider.metadata?.label ?? provider.id),
      {
        onDidChangeSessions: emitter.event,
        getSessions: (...args) => invoke(broker, provider, "getSessions", args),
        createSession: (...args) => invoke(broker, provider, "createSession", args),
        removeSession: (...args) => invoke(broker, provider, "removeSession", args),
      },
      provider.metadata?.options
    )
    const events = providerEvents(broker, provider, {
      sessionsChanged: (payload) => emitter.fire(reviveValue(payload, provider)),
    })
    return combine(vscode, emitter, registration, events)
  },
  "uri-handler": async (vscode, provider, broker) => {
    requireApi(vscode.window, "registerUriHandler", provider)
    return vscode.window.registerUriHandler({
      handleUri: (...args) => invoke(broker, provider, "handle", args),
    })
  },
  "chat-participant": async (vscode, provider, broker) => {
    requireApi(vscode.chat, "createChatParticipant", provider)
    return vscode.chat.createChatParticipant(
      provider.id,
      async (request, context, stream, token) => {
        const result = await invokeStreaming(
          vscode,
          broker,
          provider,
          "request",
          [request, context],
          token,
          {
            stream: (event) => projectAgentChatEvent(vscode, stream, event),
          }
        )
        replayChatStream(stream, result?.stream ?? [])
        return result?.result
      }
    )
  },
  "language-model-chat-provider": async (vscode, provider, broker) => {
    requireApi(vscode.lm, "registerLanguageModelChatProvider", provider)
    return vscode.lm.registerLanguageModelChatProvider(requiredMetadata(provider, "vendor"), {
      provideLanguageModelChatInformation: (options, token) =>
        invoke(broker, provider, "provideLanguageModelChatInformation", [options], token),
      async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const result = await invokeStreaming(
          vscode,
          broker,
          provider,
          "provideLanguageModelChatResponse",
          [model, messages, options],
          token,
          {
            stream: (event) => {
              const part = projectAgentLanguageModelEvent(vscode, event)
              if (part) progress.report(part)
            },
          }
        )
        for (const part of result?.stream ?? []) {
          progress.report(reviveLanguageModelPart(vscode, part))
        }
      },
      provideTokenCount: (model, text, token) =>
        invoke(broker, provider, "provideTokenCount", [model, text], token),
    })
  },
  "language-model-tool": async (vscode, provider, broker) => {
    requireApi(vscode.lm, "registerTool", provider)
    return vscode.lm.registerTool(provider.id, {
      invoke: (...args) =>
        invokeStreaming(vscode, broker, provider, "invoke", args, cancellationToken(args), {}),
      prepareInvocation: (...args) =>
        invoke(broker, provider, "prepare", args, cancellationToken(args)),
    })
  },
  "mcp-server-definition": async (vscode, provider, broker) => {
    requireApi(vscode.lm, "registerMcpServerDefinitionProvider", provider)
    const emitter = new vscode.EventEmitter()
    const registration = vscode.lm.registerMcpServerDefinitionProvider(provider.id, {
      onDidChangeMcpServerDefinitions: emitter.event,
      provideMcpServerDefinitions: (...args) =>
        invoke(broker, provider, "provide", args, cancellationToken(args)),
      resolveMcpServerDefinition: (...args) =>
        invoke(broker, provider, "resolve", args, cancellationToken(args)),
    })
    const events = providerEvents(broker, provider, {
      definitionsChanged: () => emitter.fire(),
    })
    return combine(vscode, emitter, registration, events)
  },
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor.pluginId !== "string") {
    throw compatibilityError("IDE_PROXY_DESCRIPTOR_INVALID", "pluginId is required")
  }
  const prefix = `cognia.${descriptor.pluginId}.`
  const seen = new Set()
  for (const provider of descriptor.providers ?? []) {
    if (!provider.id?.startsWith(prefix)) {
      throw compatibilityError(
        "IDE_PROXY_ID_OUTSIDE_NAMESPACE",
        `Provider ${provider.id} is outside ${prefix}`
      )
    }
    if (seen.has(provider.id)) {
      throw compatibilityError("IDE_PROVIDER_ID_CONFLICT", `Duplicate provider ${provider.id}`)
    }
    seen.add(provider.id)
  }
}

function requireApi(namespace, method, provider) {
  if (!namespace || typeof namespace[method] !== "function") {
    throw compatibilityError(
      "IDE_CODE_API_UNAVAILABLE",
      `${provider.kind} requires Code 1.128 API ${method}`
    )
  }
}

function requiredMetadata(provider, key) {
  const value = provider.metadata?.[key]
  if (typeof value !== "string" || value.length === 0) {
    throw compatibilityError(
      "IDE_PROVIDER_METADATA_REQUIRED",
      `${provider.kind} provider ${provider.id} requires metadata.${key}`
    )
  }
  return value
}

function compatibilityError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function cancellationToken(args) {
  return [...args]
    .reverse()
    .find((value) => value && typeof value === "object" && "isCancellationRequested" in value)
}

async function serializeBrokerValue(value, broker, provider, seen = new WeakSet()) {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (value instanceof Uint8Array) {
    if (typeof broker.createContent !== "function") {
      throw compatibilityError(
        "IDE_CONTENT_HANDLE_CHANNEL_UNAVAILABLE",
        "Binary provider arguments require the content handle channel"
      )
    }
    return broker.createContent(provider, value)
  }
  if (isDataTransfer(value)) {
    const items = []
    for (const [mimeType, item] of value) {
      const file = typeof item?.asFile === "function" ? item.asFile() : undefined
      if (file) {
        const data = await file.data()
        items.push({
          mimeType,
          kind: "file",
          name: file.name,
          uri: await serializeBrokerValue(file.uri, broker, provider, seen),
          data: await serializeBrokerValue(data, broker, provider, seen),
        })
      } else {
        items.push({
          mimeType,
          kind: "string",
          value: await item.asString(),
        })
      }
    }
    return { $type: "DataTransfer", items }
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => serializeBrokerValue(entry, broker, provider, seen)))
  }
  if (typeof value !== "object") return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  if (typeof value.toJSON === "function") {
    return serializeBrokerValue(value.toJSON(), broker, provider, seen)
  }
  if (value.uri && typeof value.getText === "function") {
    return {
      $type: "TextDocument",
      uri: await serializeBrokerValue(value.uri, broker, provider, seen),
      languageId: value.languageId,
      version: value.version,
      isDirty: value.isDirty,
    }
  }
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "function") {
      result[key] = await serializeBrokerValue(entry, broker, provider, seen)
    }
  }
  return result
}

function isDataTransfer(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value[Symbol.iterator] === "function" &&
    typeof value.get === "function" &&
    typeof value.set === "function"
  )
}

function applyPreparedDataTransfer(vscode, dataTransfer, result) {
  if (result == null) return
  if (!result || !Array.isArray(result.items)) {
    throw compatibilityError(
      "IDE_DATA_TRANSFER_RESULT_INVALID",
      "prepareDocumentPaste must return { items: [{ mimeType, value }] }"
    )
  }
  for (const item of result.items) {
    if (!item || typeof item.mimeType !== "string" || !("value" in item)) {
      throw compatibilityError(
        "IDE_DATA_TRANSFER_RESULT_INVALID",
        "Prepared data transfer items require mimeType and value"
      )
    }
    dataTransfer.set(item.mimeType, new vscode.DataTransferItem(item.value))
  }
}

async function reviveBrokerValue(value, broker, provider) {
  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => reviveBrokerValue(entry, broker, provider)))
  }
  if (!value || typeof value !== "object") return value
  if (value.$type === "ContentHandle") {
    if (typeof broker.readContent !== "function") {
      throw compatibilityError(
        "IDE_CONTENT_HANDLE_CHANNEL_UNAVAILABLE",
        "Binary provider results require the content handle channel"
      )
    }
    return broker.readContent(provider, value)
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value)
        .filter(([key]) => key !== "$type")
        .map(async ([key, entry]) => [key, await reviveBrokerValue(entry, broker, provider)])
    )
  )
}

function reviveValue(value, provider) {
  if (Array.isArray(value)) return value.map((entry) => reviveValue(entry, provider))
  if (!value || typeof value !== "object") return value
  // Most VS Code provider result types are structural. Strip the transport tag
  // and recursively revive nested values without executing arbitrary constructors.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$type")
      .map(([key, entry]) => [key, reviveValue(entry, provider)])
  )
}

function reviveRange(vscode, value) {
  return new vscode.Range(
    value?.start?.line ?? 0,
    value?.start?.character ?? 0,
    value?.end?.line ?? 0,
    value?.end?.character ?? 0
  )
}

function ensureBytes(value) {
  if (value instanceof Uint8Array) return value
  throw compatibilityError("IDE_BINARY_RESULT_INVALID", "Expected redeemed content bytes")
}

function combine(vscode, ...disposables) {
  if (vscode.Disposable?.from) return vscode.Disposable.from(...disposables)
  return {
    dispose() {
      for (const disposable of disposables.reverse()) disposable.dispose()
    },
  }
}

function providerEvents(broker, provider, handlers, invocationId) {
  if (typeof broker.onEvent !== "function") {
    return { dispose() {} }
  }
  return broker.onEvent((message) => {
    if (
      message?.providerId !== provider.id ||
      (invocationId !== undefined && message.invocationId !== invocationId) ||
      typeof message.event !== "string"
    ) {
      return
    }
    const handler = handlers[message.event]
    if (typeof handler !== "function") {
      throw compatibilityError(
        "IDE_PROVIDER_EVENT_UNSUPPORTED",
        `${provider.kind}:${message.event}`
      )
    }
    void Promise.resolve(handler(message.payload)).catch(() => {
      // Provider event callbacks are isolated from the extension-host event
      // pump. Approval handlers fail closed by sending a denial themselves.
    })
  })
}

function remoteDisposable(vscode, broker, provider, operation, args) {
  void invoke(broker, provider, operation, args)
  return new vscode.Disposable(() => {
    void invoke(broker, provider, `${operation}/dispose`, args)
  })
}

function validateWebviewHtml(html) {
  const value = String(html)
  if (
    !/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+default-src\s+['"]none['"]/i.test(
      value
    )
  ) {
    throw compatibilityError(
      "IDE_WEBVIEW_CSP_REQUIRED",
      "Managed webviews require a Content-Security-Policy with default-src 'none'"
    )
  }
  return value
}

function replaceTestItems(vscode, controller, parent, definitions) {
  const collection = parent?.children ?? controller.items
  collection.replace(
    definitions.map((definition) => {
      const item = controller.createTestItem(
        definition.id,
        definition.label,
        definition.uri ? reviveValue(definition.uri) : undefined
      )
      item.canResolveChildren = definition.canResolveChildren === true
      item.range = definition.range
      item.tags = (definition.tags ?? []).map((tag) => new vscode.TestTag(tag))
      return item
    })
  )
}

function replayChatStream(stream, events) {
  for (const event of events) {
    const method = event?.method
    if (
      !["markdown", "anchor", "button", "filetree", "progress", "reference", "push"].includes(
        method
      )
    ) {
      throw compatibilityError(
        "IDE_CHAT_STREAM_EVENT_INVALID",
        `Unknown chat stream event ${method}`
      )
    }
    stream[method](...(event.arguments ?? []))
  }
}

function projectAgentChatEvent(vscode, stream, event) {
  if (!event || typeof event !== "object") {
    throw compatibilityError("IDE_AGENT_STREAM_INVALID", "Agent stream event must be an object")
  }
  if (event.type === "text-delta") {
    stream.markdown(String(event.delta ?? ""))
    return
  }
  if (event.type === "tool-call") {
    stream.progress(localize(vscode, 'Running tool "{0}"', String(event.toolName ?? "")))
    return
  }
  if (event.type === "tool-result") {
    stream.progress(
      localize(
        vscode,
        event.isError ? 'Tool "{0}" failed' : 'Tool "{0}" completed',
        String(event.toolName ?? "")
      )
    )
    return
  }
  if (event.type === "compact") {
    stream.progress(localize(vscode, "Agent context compacted"))
  }
}

function projectAgentLanguageModelEvent(vscode, event) {
  if (!event || typeof event !== "object") {
    throw compatibilityError("IDE_AGENT_STREAM_INVALID", "Agent stream event must be an object")
  }
  if (event.type === "text-delta") {
    return new vscode.LanguageModelTextPart(String(event.delta ?? ""))
  }
  if (event.type === "tool-call") {
    return new vscode.LanguageModelToolCallPart(
      String(event.id ?? `cognia-${Date.now()}`),
      String(event.toolName ?? ""),
      event.input ?? {}
    )
  }
  return undefined
}

async function projectAgentApproval(vscode, broker, provider, invocationId, payload) {
  const requestId = payload?.requestId
  const toolName = payload?.toolName
  if (typeof requestId !== "string" || typeof toolName !== "string") {
    throw compatibilityError("IDE_AGENT_APPROVAL_INVALID", "Approval correlation is required")
  }
  if (typeof broker.respondApproval !== "function") {
    throw compatibilityError(
      "IDE_AGENT_APPROVAL_CHANNEL_UNAVAILABLE",
      "Managed agent approval response channel is unavailable"
    )
  }
  const allow = localize(vscode, "Allow")
  const deny = localize(vscode, "Deny")
  let selected
  try {
    selected = await vscode.window.showWarningMessage(
      localize(vscode, 'Allow managed agent tool "{0}"?', toolName),
      {
        modal: true,
        detail: boundedJson(payload.input),
      },
      allow,
      deny
    )
  } catch {
    selected = undefined
  }
  broker.respondApproval(
    provider,
    invocationId,
    requestId,
    selected === allow ? "allow" : "deny",
    undefined,
    selected === allow ? undefined : localize(vscode, "Denied in Pro IDE")
  )
}

function boundedJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2).slice(0, 4_000)
  } catch {
    return "{}"
  }
}

function localize(vscode, message, ...args) {
  return typeof vscode.l10n?.t === "function" ? vscode.l10n.t(message, ...args) : message
}

function reviveLanguageModelPart(vscode, value) {
  if (!value || typeof value !== "object") {
    throw compatibilityError(
      "IDE_LANGUAGE_MODEL_STREAM_INVALID",
      "Language model stream parts must be typed objects"
    )
  }
  if (value.$type === "LanguageModelTextPart") {
    return new vscode.LanguageModelTextPart(String(value.value ?? ""))
  }
  if (value.$type === "LanguageModelToolCallPart") {
    return new vscode.LanguageModelToolCallPart(
      String(value.callId ?? ""),
      String(value.name ?? ""),
      value.input
    )
  }
  if (value.$type === "LanguageModelDataPart") {
    return new vscode.LanguageModelDataPart(
      Uint8Array.from(value.data ?? []),
      String(value.mimeType ?? "application/octet-stream")
    )
  }
  throw compatibilityError(
    "IDE_LANGUAGE_MODEL_STREAM_INVALID",
    `Unknown language model stream part ${String(value.$type)}`
  )
}
