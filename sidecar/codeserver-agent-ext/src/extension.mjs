// Cognia Agent Bridge — a VS Code extension side-loaded into the embedded
// code-server (Pro IDE Phase 2). It dials the app's loopback agent channel and
// lets the Cognia agent drive the live editor: open/reveal a file, reflect an
// on-disk write as an undo-able edit, and read the active-editor context back.
//
// Dormant unless launched by Cognia: `activate` returns immediately when the
// `COGNIA_CS_AGENT_PORT` / `COGNIA_CS_AGENT_CREDENTIAL_FILE` env vars are
// absent, so the extension is inert in any other code-server. The environment
// never carries the broker secret itself; see `broker-credential.mjs`.
//
// This file only wires VS Code to the pieces that do the work, each of which
// takes `vscode` (or nothing) as a parameter so it is testable under
// `node --test`: the connection (`agent-bridge.mjs`), the editor verbs
// (`editor-verbs.mjs`) and the chat context capture (`chat-context.mjs`).

import { randomUUID } from "node:crypto"
import * as vscode from "vscode"
import nls from "../package.nls.json" with { type: "json" }
import { AgentBridge } from "./agent-bridge.mjs"
import {
  captureChatContext,
  captureDiagnosticsContext,
  captureFileContext,
} from "./chat-context.mjs"
import { ContentHandleClient } from "./content-handles.mjs"
import { findOccupiedContributionIds } from "./contribution-ids.mjs"
import { PROPOSED_SCHEME, createEditorVerbs } from "./editor-verbs.mjs"
import { proxyApi } from "./proxy-api.mjs"
import { createTestProbe, probe } from "./test-probe.mjs"
import { WorkspacePanel } from "./workspace-panel.mjs"

/**
 * The workspace panel, and the app-supplied data it renders.
 *
 * `customActions` and `panelStrings` live here rather than in the panel because
 * the chat-context commands need them too. Strings the app pushes with the
 * snapshot win, because they follow the app's language; until the first
 * snapshot arrives (and while disconnected) the extension's own localized copy
 * of the same catalog entries is used — see {@link panelText}.
 */
let workspacePanel = null
let customActions = []
let panelStrings = {}
let editorVerbs = null

const IDE_CATALOG_HASH = "sha256:53cf23036ed2e14693f284778d7f2b0cd7cd5802ee63bb42c573063f40f86fb3"

/**
 * A `panel.*` string: the app's pushed copy if there is one, otherwise the
 * extension's localization of the same catalog entry.
 *
 * Both come from `i18n/messages/<locale>/proIde.json`: `package.nls.json` holds
 * the English text, which is also the key `vscode.l10n.t` looks up in the
 * generated `l10n/bundle.l10n.<locale>.json` (`scripts/i18n/build-vscode-nls.mjs`).
 */
export function panelText(key) {
  const pushed = panelStrings[key]
  if (typeof pushed === "string" && pushed.length > 0) return pushed
  return vscode.l10n.t(nls[`panel.${key}`])
}

let bridge = null
let contentHandles = null
const proxyRegistrations = new Map()

/** How long a proxy activating at startup waits for the broker to connect. */
const PROXY_BRIDGE_READY_TIMEOUT_MS = 30_000

async function registerProxy(context, descriptor, proxyVscode) {
  if (!bridge) throw new Error("Managed IDE broker is not active")
  await bridge.whenReady(PROXY_BRIDGE_READY_TIMEOUT_MS)
  const api = proxyApi(proxyVscode, vscode)
  if (descriptor.platformVersion !== "1.0.0") {
    throw new Error("IDE_PLATFORM_VERSION_MISMATCH")
  }
  if (descriptor.catalogHash !== IDE_CATALOG_HASH) {
    throw new Error("IDE_CATALOG_MISMATCH")
  }
  const runtimeDescriptor = {
    ...descriptor,
    contributions: context.extension.packageJSON?.contributes ?? {},
  }
  const collisions = findOccupiedContributionIds(vscode, runtimeDescriptor, context.extension.id)
  if (collisions.length > 0) {
    throw new Error(
      `IDE_CONTRIBUTION_ID_OCCUPIED: ${collisions
        .map((entry) => `${entry.kind}:${entry.id}@${entry.extensionId}`)
        .join(", ")}`
    )
  }
  const { createManagedStorageFacade } = await import("./managed-storage.mjs")
  const managedStorage = await createManagedStorageFacade({
    request: (method, params) => bridge.request(method, params),
    descriptor: runtimeDescriptor,
    hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
    workspaceRoot: process.env.COGNIA_CS_WORKSPACE ?? "",
    getWorkspaceTrusted: () => vscode.workspace.isTrusted,
  })
  const { registerManagedProviders } = await import("./provider-adapters.mjs")
  let providerRegistration
  try {
    providerRegistration = await registerManagedProviders(api, runtimeDescriptor, {
      managedStorage,
      onEvent: (listener) =>
        bridge.onNotification((message) => {
          if (message?.pluginId === runtimeDescriptor.pluginId) listener(message)
        }),
      createInvocationId: () => randomUUID(),
      invoke: (provider, operation, args, token, suppliedInvocationId) => {
        const invocationId = suppliedInvocationId ?? randomUUID()
        const request = bridge.request("cognia/provider/invoke", {
          invocationId,
          pluginId: runtimeDescriptor.pluginId,
          pluginVersion: runtimeDescriptor.pluginVersion,
          manifestHash: runtimeDescriptor.manifestHash,
          catalogHash: runtimeDescriptor.catalogHash,
          hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
          workspaceRoot: process.env.COGNIA_CS_WORKSPACE ?? "",
          workspaceTrusted: vscode.workspace.isTrusted,
          providerId: provider.id,
          providerKind: provider.kind,
          handler: provider.handler,
          permission: provider.permission ?? null,
          operation,
          arguments: args,
        })
        token?.onCancellationRequested(() => {
          // The request owns its JSON-RPC cancellation id internally; cancellation
          // is also carried as a provider operation so the host can stop work even
          // when the callback arrived before the pending id was observable here.
          bridge?.notify("cognia/provider/cancel", {
            invocationId,
            pluginId: runtimeDescriptor.pluginId,
            providerId: provider.id,
            operation,
          })
        })
        return request
      },
      respondApproval: (provider, invocationId, requestId, decision, updatedInput, message) => {
        bridge.notify("cognia/provider/approvalResponse", {
          invocationId,
          requestId,
          pluginId: runtimeDescriptor.pluginId,
          providerId: provider.id,
          decision,
          ...(updatedInput ? { updatedInput } : {}),
          ...(message ? { message } : {}),
        })
      },
      createContent: (provider, bytes) => {
        if (!contentHandles) throw new Error("IDE_CONTENT_HANDLE_CHANNEL_UNAVAILABLE")
        return contentHandles.upload({ ...provider, pluginId: runtimeDescriptor.pluginId }, bytes)
      },
      readContent: (provider, handle) => {
        if (!contentHandles) throw new Error("IDE_CONTENT_HANDLE_CHANNEL_UNAVAILABLE")
        return contentHandles.download(
          { ...provider, pluginId: runtimeDescriptor.pluginId },
          handle
        )
      },
    })
  } catch (error) {
    managedStorage.dispose()
    throw error
  }
  let protocolRegistration
  try {
    const { registerManagedProtocols } = await import("./protocol-adapters.mjs")
    const protocolParams = (family, server, extra = {}) => ({
      invocationId: randomUUID(),
      pluginId: runtimeDescriptor.pluginId,
      pluginVersion: runtimeDescriptor.pluginVersion,
      manifestHash: runtimeDescriptor.manifestHash,
      catalogHash: runtimeDescriptor.catalogHash,
      hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
      workspaceRoot: process.env.COGNIA_CS_WORKSPACE ?? "",
      workspaceTrusted: vscode.workspace.isTrusted,
      family,
      protocolId: server.id,
      ...extra,
    })
    protocolRegistration = await registerManagedProtocols(api, runtimeDescriptor, {
      onEvent: (listener) =>
        bridge.onNotification((message) => {
          if (message?.pluginId === runtimeDescriptor.pluginId) listener(message)
        }),
      startProtocol: (family, server, consumerId) =>
        bridge.request(
          "cognia/protocol/start",
          protocolParams(family, server, consumerId ? { consumerId } : {})
        ),
      requestProtocol: (family, server, capabilityTicket, method, payload, token, consumerId) => {
        const invocationId = randomUUID()
        const request = bridge.request(
          "cognia/protocol/request",
          protocolParams(family, server, {
            invocationId,
            capabilityTicket,
            method,
            payload,
            ...(consumerId ? { consumerId } : {}),
          })
        )
        token?.onCancellationRequested(() => {
          bridge?.notify("cognia/protocol/cancel", {
            invocationId,
            pluginId: runtimeDescriptor.pluginId,
            protocolId: server.id,
            ...(consumerId ? { consumerId } : {}),
          })
        })
        return request
      },
      documentProtocol: (family, server, capabilityTicket, document, consumerId) =>
        bridge.request(
          "cognia/protocol/document",
          protocolParams(family, server, {
            capabilityTicket,
            document,
            ...(consumerId ? { consumerId } : {}),
          })
        ),
      stopProtocol: (family, server, capabilityTicket, consumerId) =>
        bridge.request(
          "cognia/protocol/stop",
          protocolParams(family, server, {
            capabilityTicket,
            ...(consumerId ? { consumerId } : {}),
          })
        ),
    })
  } catch (error) {
    providerRegistration.dispose()
    managedStorage.dispose()
    throw error
  }
  const registration = vscode.Disposable.from(
    managedStorage,
    providerRegistration,
    protocolRegistration
  )
  const previous = proxyRegistrations.get(runtimeDescriptor.pluginId)
  previous?.dispose()
  proxyRegistrations.set(runtimeDescriptor.pluginId, registration)
  context.subscriptions.push(registration)
  return {
    generation: bridge.negotiated?.generation,
    providerCount: runtimeDescriptor.providers?.length ?? 0,
    managedContext: {
      globalState: managedStorage.globalState,
      workspaceState: managedStorage.workspaceState,
      secrets: managedStorage.secrets,
    },
  }
}

export function activate(context) {
  const portRaw = process.env.COGNIA_CS_AGENT_PORT
  const credentialFile = process.env.COGNIA_CS_AGENT_CREDENTIAL_FILE
  // Not launched by Cognia — stay completely dormant.
  if (!portRaw || !credentialFile) return undefined
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0) return undefined
  const contentPort = Number(process.env.COGNIA_CS_CONTENT_PORT)
  if (!Number.isInteger(contentPort) || contentPort <= 0) return undefined

  editorVerbs = createEditorVerbs(vscode, {
    onSnapshot: applySnapshot,
    getProxyRegistration: (pluginId) => proxyRegistrations.get(pluginId),
    // `null` unless the host was started for the real-binary E2E.
    testProbe: createTestProbe(vscode, probe, {
      emit: (name, payload) => bridge?.emit(name, () => payload, { coalesce: false }) ?? false,
    }),
  })
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PROPOSED_SCHEME,
      editorVerbs.proposedProvider
    )
  )

  // Built before the bridge connects so the container exists and can say "not
  // connected"; a view that materializes only after the first push reads as
  // broken to anyone who looks before then.
  workspacePanel = new WorkspacePanel((row) => {
    if (row?.path) {
      void editorVerbs.openFile({ path: row.path, line: row.line }).catch(() => {
        // The file moved or was deleted since the app built the snapshot; fall
        // back to handing the row to Cognia, which can still show the item.
        bridge?.emit("workspaceRowActivated", () => row, { coalesce: false })
      })
      return
    }
    bridge?.emit("workspaceRowActivated", () => row, { coalesce: false })
  })
  workspacePanel.setDisconnected(panelText("disconnected"))
  context.subscriptions.push(workspacePanel)

  bridge = new AgentBridge({
    port,
    credentialFile,
    hostId: process.env.COGNIA_CS_HOST_ID ?? "local",
    workspace: process.env.COGNIA_CS_WORKSPACE ?? "",
    catalogHash: IDE_CATALOG_HASH,
    dispatch: (method, params, options) => editorVerbs.dispatch(method, params, options),
    onConnectionChange: (connected) => {
      if (connected) {
        // Ask the app for a fresh snapshot now instead of waiting for its next
        // periodic push; until it lands the panel keeps saying "not connected".
        bridge?.emit("bridgeConnected", () => ({}), { coalesce: false })
      } else {
        // The last snapshot is stale the moment the bridge drops.
        workspacePanel?.setDisconnected(panelText("disconnected"))
      }
    },
  })
  const liveBridge = bridge
  contentHandles = new ContentHandleClient({
    port: contentPort,
    credential: () => liveBridge.contentBearer(),
  })
  bridge.start()

  // Push editor state instead of making the app poll for it. Every handler reports
  // only the shape the app needs to decide whether to re-read — the authoritative
  // snapshot still comes from `readActive`, so these stay small and cheap.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      bridge?.emit("activeEditorChanged", () => ({
        path: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
      }))
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // Only the focused editor: a background editor's selection changing (e.g. from
      // a find-all) is not "what the user is looking at".
      if (event.textEditor !== vscode.window.activeTextEditor) return
      bridge?.emit("selectionChanged", () => ({
        path: event.textEditor.document.uri.fsPath,
        empty: event.textEditor.selection.isEmpty,
      }))
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return
      bridge?.emit("documentSaved", () => ({ path: doc.uri.fsPath }))
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      const active = vscode.window.activeTextEditor?.document
      if (!active || active.uri.scheme !== "file") return
      bridge?.emit("diagnosticsChanged", () => ({
        path: active.uri.fsPath,
        count: vscode.languages.getDiagnostics(active.uri).length,
      }))
    }),
    {
      dispose: () => {
        bridge?.dispose()
        bridge = null
        editorVerbs?.dispose()
        editorVerbs = null
      },
    }
  )

  // ── Chat context commands ──────────────────────────────────────────────
  // These register the right-click menu actions that push editor context to
  // the Cognia chat via the event channel. The renderer stages the payload as
  // a FileSelectionRef context chip and optionally pre-fills the composer.
  // Each invocation is its own request, so none of them is coalesced.
  const sendChatContext = (ctx) => {
    if (ctx) bridge?.emit("chatContextRequested", () => ctx, { coalesce: false })
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("cognia.chat.addSelection", () => {
      sendChatContext(captureChatContext(vscode, "addSelection"))
    }),
    vscode.commands.registerCommand("cognia.chat.addFile", (uri) => {
      // `uri` is provided when invoked from the explorer context menu
      sendChatContext(uri ? captureFileContext(vscode, uri) : captureChatContext(vscode, "addFile"))
    }),
    vscode.commands.registerCommand("cognia.chat.explain", () => {
      sendChatContext(captureChatContext(vscode, "explain"))
    }),
    vscode.commands.registerCommand("cognia.chat.fix", () => {
      sendChatContext(captureChatContext(vscode, "fix"))
    }),
    vscode.commands.registerCommand("cognia.chat.review", () => {
      sendChatContext(captureChatContext(vscode, "review"))
    }),
    vscode.commands.registerCommand("cognia.chat.customAction", async () => {
      // Sourced from the app's unified template platform, pushed with the
      // workspace snapshot — NOT from a `cognia.customActions` array in
      // code-server's own settings.json, which was an island: templates edited
      // in Cognia never reached it, and actions defined in it existed nowhere
      // else. There is exactly one place to define a prompt action now.
      const actions = customActions
      if (actions.length === 0) {
        vscode.window.showInformationMessage(panelText("noCustomActions"))
        return
      }
      const picked = await vscode.window.showQuickPick(
        actions.map((a) => ({ label: a.label, description: a.prompt, action: a })),
        { placeHolder: panelText("chooseAction") }
      )
      if (!picked) return
      const ctx = captureChatContext(vscode, "custom")
      if (!ctx) return
      ctx.customPrompt = picked.action.prompt
      ctx.customLabel = picked.action.label
      sendChatContext(ctx)
    }),
    // ── Workspace panel ─────────────────────────────────────────────────
    vscode.commands.registerCommand("cognia.workspace.focus", () => {
      void vscode.commands.executeCommand("workbench.view.extension.cognia")
    }),
    // Manual, not automatic: a threshold that files issues by itself turns one
    // large refactor into a flooded backlog. The status bar tints when the app
    // says so; sending is always a person's click.
    vscode.commands.registerCommand("cognia.diagnostics.send", () => {
      const payload = captureDiagnosticsContext(vscode)
      if (!payload) {
        vscode.window.showInformationMessage(panelText("noDiagnostics"))
        return
      }
      bridge?.emit("diagnosticsHandoffRequested", () => payload, { coalesce: false })
    })
  )

  return {
    registerProxy: (proxyContext, descriptor, proxyVscode) =>
      registerProxy(proxyContext, descriptor, proxyVscode),
  }
}

/** Apply a workspace snapshot the app pushed. */
function applySnapshot(params) {
  panelStrings = params.strings && typeof params.strings === "object" ? params.strings : {}
  customActions = Array.isArray(params.customActions) ? params.customActions : []
  workspacePanel?.apply({
    statusText: typeof params.statusText === "string" ? params.statusText : "",
    statusTooltip: typeof params.statusTooltip === "string" ? params.statusTooltip : undefined,
    attention: params.attention === true,
    groups: Array.isArray(params.groups) ? params.groups : [],
  })
}

export function deactivate() {
  bridge?.dispose()
  bridge = null
  editorVerbs?.dispose()
  editorVerbs = null
  workspacePanel?.dispose()
  workspacePanel = null
  customActions = []
  panelStrings = {}
  for (const registration of proxyRegistrations.values()) registration.dispose()
  proxyRegistrations.clear()
}
