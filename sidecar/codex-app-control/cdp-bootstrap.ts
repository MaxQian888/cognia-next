import { stat } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"

import { commandResult, sleep, waitFor } from "./shared.ts"

/** A page target from the CDP `/json/list` endpoint. */
export interface CdpTarget {
  id?: string
  type?: string
  url?: string
  webSocketDebuggerUrl: string
}

/** A CDP command response (`Runtime.evaluate` and friends). */
export interface CdpCommandResult {
  result?: { value?: unknown }
  exceptionDetails?: unknown
  [key: string]: unknown
}

export interface CdpEventWaitOptions {
  predicate?: (params: Record<string, unknown>) => boolean
  timeoutMs?: number
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>): Promise<CdpCommandResult>
  waitForEvent(method: string, options?: CdpEventWaitOptions): Promise<Record<string, unknown>>
  close(): void
}

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * The value an injected renderer script returned, as a record of optional
 * fields: the script is ours, but the value crossed the CDP wire, so every
 * field is checked where it is read.
 */
function evaluatedValue<T extends object>(evaluated: CdpCommandResult): Partial<T> | null {
  const value = evaluated.result?.value
  return isRecord(value) ? (value as Partial<T>) : null
}

const BOOTSTRAP_MARKER_PREFIX = "COGNIA_BOOTSTRAP:"
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COMPOSER_SUBMIT_PATTERN = /^(send(?: message)?|submit|run|queue|发送|提交|运行|排队)$/i

function requiredString(
  value: unknown,
  name: string,
  { maxLength = 16_000 }: { maxLength?: number } = {}
): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`)
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`)
  return value.trim()
}

function validBrowserUrl(value: unknown): string {
  const url = new URL(requiredString(value, "browserUrl", { maxLength: 8000 }))
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("browserUrl must use http or https")
  }
  return url.toString()
}

export interface CodexTaskDeepLinkInput {
  prompt: unknown
  browserUrl?: unknown
  workspace: unknown
  nonce: unknown
}

export function buildCodexTaskDeepLink({
  prompt,
  browserUrl,
  workspace,
  nonce,
}: CodexTaskDeepLinkInput): string {
  const cleanPrompt = requiredString(prompt, "prompt")
  const cleanNonce = requiredString(nonce, "nonce", { maxLength: 128 })
  if (!/^[A-Za-z0-9._-]+$/.test(cleanNonce)) {
    throw new Error("nonce contains unsupported characters")
  }
  const cleanWorkspace = resolve(requiredString(workspace, "workspace", { maxLength: 4096 }))
  if (!isAbsolute(cleanWorkspace)) throw new Error("workspace must be absolute")

  const url = new URL("codex://new")
  url.searchParams.set("path", cleanWorkspace)
  url.searchParams.set("prompt", `${cleanPrompt}\n\n[${BOOTSTRAP_MARKER_PREFIX}${cleanNonce}]`)
  if (browserUrl != null && browserUrl !== "") {
    url.searchParams.set("browserUrl", validBrowserUrl(browserUrl))
  }
  return url.toString()
}

export function buildCodexThreadDeepLink(threadId: unknown): string {
  const value = requiredString(threadId, "threadId", { maxLength: 64 })
  if (!THREAD_ID_PATTERN.test(value)) throw new Error("threadId is invalid")
  return `codex://threads/${value}`
}

export function isComposerSubmitLabel(value: unknown): boolean {
  return typeof value === "string" && COMPOSER_SUBMIT_PATTERN.test(value.trim())
}

export function selectCodexRendererTarget(targets: unknown): CdpTarget | null {
  if (!Array.isArray(targets)) return null
  return (
    (targets as unknown[]).find(
      (target): target is CdpTarget =>
        isRecord(target) &&
        target.type === "page" &&
        typeof target.webSocketDebuggerUrl === "string" &&
        (String(target.url ?? "").startsWith("app://") ||
          String(target.url ?? "").startsWith("codex-sandbox://"))
    ) ?? null
  )
}

export async function discoverCodexRenderer(
  cdpPort: number,
  { fetchImpl = fetch as FetchLike }: { fetchImpl?: FetchLike } = {}
): Promise<CdpTarget | null> {
  const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json/list`, {
    signal: AbortSignal.timeout(2000),
  })
  if (!response.ok) throw new Error(`CDP target discovery failed with HTTP ${response.status}`)
  return selectCodexRendererTarget(await response.json())
}

export async function waitForCodexRenderer(
  cdpPort: number,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; intervalMs?: number } = {}
): Promise<CdpTarget> {
  return waitFor(() => discoverCodexRenderer(cdpPort, options).catch(() => null), {
    timeoutMs: options.timeoutMs ?? 15_000,
    intervalMs: options.intervalMs ?? 200,
    description: "Codex renderer CDP target",
  })
}

async function eventDataText(data: unknown): Promise<string> {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8")
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8")
  }
  if (isRecord(data) && typeof data.text === "function")
    return String(await (data.text as () => unknown)())
  return String(data)
}

/** A pending command or event waiter on the CDP socket. */
interface Waiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** The parts of the WHATWG WebSocket a CDP connection uses (injectable for tests). */
export interface WebSocketLike {
  addEventListener(
    type: "open" | "error" | "close",
    listener: () => void,
    options?: { once?: boolean }
  ): void
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void
  send(data: string): void
  close(): void
}
export type WebSocketConstructor = new (url: string) => WebSocketLike

export async function connectCdp(
  webSocketDebuggerUrl: string,
  {
    WebSocketImpl = globalThis.WebSocket as unknown as WebSocketConstructor | undefined,
    timeoutMs = 5000,
  }: { WebSocketImpl?: WebSocketConstructor | undefined; timeoutMs?: number } = {}
): Promise<CdpConnection> {
  if (typeof WebSocketImpl !== "function")
    throw new Error("WebSocket is unavailable in this Node runtime")
  const socket = new WebSocketImpl(webSocketDebuggerUrl)
  const pending = new Map<number, Waiter<CdpCommandResult>>()
  const eventWaiters = new Map<string, Set<Waiter<Record<string, unknown>> & CdpEventWaitOptions>>()
  let nextId = 0

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("Timed out connecting to CDP")), timeoutMs)
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolveOpen()
      },
      { once: true }
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        rejectOpen(new Error("Unable to connect to the Codex renderer CDP target"))
      },
      { once: true }
    )
  })

  socket.addEventListener("message", async (event) => {
    let message: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await eventDataText(event.data))
      if (!isRecord(parsed)) return
      message = parsed
    } catch {
      return
    }
    if (message.id != null) {
      const id = message.id as number
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      const error = isRecord(message.error) ? message.error : null
      if (error) entry.reject(new Error(`${String(error.code)}: ${String(error.message)}`))
      else entry.resolve((isRecord(message.result) ? message.result : {}) as CdpCommandResult)
      return
    }
    if (typeof message.method !== "string" || !message.method) return
    const waiters = eventWaiters.get(message.method)
    if (!waiters) return
    const params = isRecord(message.params) ? message.params : {}
    for (const entry of [...waiters]) {
      if (entry.predicate && !entry.predicate(params)) continue
      waiters.delete(entry)
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolve(params)
    }
    if (waiters.size === 0) eventWaiters.delete(message.method)
  })

  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new Error("CDP connection closed"))
    }
    pending.clear()
    for (const waiters of eventWaiters.values()) {
      for (const entry of waiters) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(new Error("CDP connection closed"))
      }
    }
    eventWaiters.clear()
  })

  return {
    send(method, params = {}) {
      const id = ++nextId
      return new Promise<CdpCommandResult>((resolveCommand, rejectCommand) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectCommand(new Error(`Timed out waiting for CDP ${method}`))
        }, timeoutMs)
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    waitForEvent(method, options = {}) {
      return new Promise<Record<string, unknown>>((resolveEvent, rejectEvent) => {
        const waiters = eventWaiters.get(method) ?? new Set()
        const entry: Waiter<Record<string, unknown>> & CdpEventWaitOptions = {
          predicate: options.predicate,
          resolve: resolveEvent,
          reject: rejectEvent,
          timer: null,
        }
        entry.timer = setTimeout(() => {
          waiters.delete(entry)
          if (waiters.size === 0) eventWaiters.delete(method)
          rejectEvent(new Error(`Timed out waiting for CDP event ${method}`))
        }, options.timeoutMs ?? timeoutMs)
        waiters.add(entry)
        eventWaiters.set(method, waiters)
      })
    },
    close() {
      socket.close()
    },
  }
}

function checkedFilePaths(values: unknown): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error("filePaths is required")
  if (values.length > 20) throw new Error("at most 20 files can be attached")
  return [...new Set(values as unknown[])].map((value) => {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error("attachment paths must be absolute")
    }
    return value
  })
}

function selectedConversationExpression(threadId: string): string {
  return `(() => {
    const expected = ${JSON.stringify(threadId)};
    const rendered = [...new Set([...document.querySelectorAll('[data-response-annotation-conversation]')]
      .map((element) => element.getAttribute('data-response-annotation-conversation'))
      .filter(Boolean))];
    return { expected, rendered, selected: rendered.includes(expected) };
  })()`
}

function composerSubmitExpression(nonce: string, threadId: string | null = null): string {
  const marker = `[${BOOTSTRAP_MARKER_PREFIX}${nonce}]`
  return `(() => {
    const marker = ${JSON.stringify(marker)};
    const expectedThreadId = ${JSON.stringify(threadId)};
    if (expectedThreadId) {
      const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((element) => element.getAttribute('data-response-annotation-conversation'));
      if (!rendered.includes(expectedThreadId)) {
        return { composerFound: false, promptMatched: false, submitted: false, reason: 'wrong_conversation' };
      }
    }
    const candidates = [document.activeElement, ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter((element, index, all) => element && all.indexOf(element) === index);
    const readText = (element) => typeof element.value === 'string' ? element.value : (element.innerText || element.textContent || '');
    const composer = candidates.find((element) => readText(element).includes(marker));
    if (!composer) return { composerFound: false, promptMatched: false, submitted: false, reason: 'prompt_not_found' };
    composer.focus();
    const scope = composer.closest('[data-composer-layout]') || composer.closest('form') || document;
    const buttons = [...scope.querySelectorAll('button')];
    const submitPattern = new RegExp(${JSON.stringify(COMPOSER_SUBMIT_PATTERN.source)}, ${JSON.stringify(COMPOSER_SUBMIT_PATTERN.flags)});
    const matchingLabel = (element) => [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent]
      .filter(Boolean).map((value) => value.trim()).find((value) => submitPattern.test(value));
    const submit = buttons.find((element) => !element.disabled && element.getAttribute('aria-disabled') !== 'true' && matchingLabel(element));
    if (!submit) return { composerFound: true, promptMatched: true, submitted: false, reason: 'submit_button_not_found' };
    const buttonLabel = matchingLabel(submit);
    submit.click();
    return { composerFound: true, promptMatched: true, submitted: true, method: 'button', buttonLabel };
  })()`
}

function focusComposerExpression(threadId: string): string {
  return `(() => {
    const expectedThreadId = ${JSON.stringify(threadId)};
    const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
      .map((element) => element.getAttribute('data-response-annotation-conversation'));
    if (!rendered.includes(expectedThreadId)) return { composerFound: false, selected: false };
    const preferred = [...document.querySelectorAll('[data-codex-composer="true"]')];
    const candidates = (preferred.length ? preferred : [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')])
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.disabled;
      });
    const composer = candidates.at(-1);
    if (!composer) return { composerFound: false, selected: true };
    const clone = composer.cloneNode(true);
    clone.querySelectorAll('[plugin-mention-name]').forEach((element) => element.remove());
    const text = typeof composer.value === 'string' ? composer.value : (clone.textContent || '');
    if (text.trim()) return { composerFound: true, empty: false, reason: 'draft_not_empty' };
    composer.focus();
    if (composer.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { composerFound: true, empty: true, selected: true, hasPluginMention: Boolean(composer.querySelector('[plugin-mention-name]')) };
  })()`
}

function attachmentInjectionExpression(
  threadId: string | null,
  descriptors: readonly AttachmentDescriptor[]
): string {
  return `(() => {
    const expectedThreadId = ${JSON.stringify(threadId)};
    if (expectedThreadId) {
      const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((element) => element.getAttribute('data-response-annotation-conversation'));
      if (!rendered.includes(expectedThreadId)) return { injected: false, reason: 'wrong_conversation' };
    }
    const files = ${JSON.stringify(descriptors)};
    for (const file of files) {
      window.postMessage({ type: 'add-context-file', file }, window.location.origin);
    }
    return { injected: true, count: files.length };
  })()`
}

function attachmentVerificationExpression(
  threadId: string | null,
  names: readonly string[],
  baselineLabels: readonly unknown[] = []
): string {
  return `(() => {
    const expectedThreadId = ${JSON.stringify(threadId)};
    if (expectedThreadId) {
      const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
        .map((element) => element.getAttribute('data-response-annotation-conversation'));
      if (!rendered.includes(expectedThreadId)) return { ready: false, reason: 'wrong_conversation' };
    }
    const expected = ${JSON.stringify(names)};
    const baseline = ${JSON.stringify(baselineLabels)};
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
    const containers = [...document.querySelectorAll('[data-composer-attachments]')].filter(visible);
    const labels = containers.flatMap((container) => [...container.querySelectorAll('span')]
      .filter((element) => element.childElementCount === 0)
      .map((element) => element.textContent?.trim()).filter(Boolean));
    const requiredCounts = [...baseline, ...expected]
      .reduce((counts, name) => ({ ...counts, [name]: (counts[name] || 0) + 1 }), {});
    const attached = Object.entries(requiredCounts)
      .filter(([name, count]) => labels.filter((label) => label === name).length >= count)
      .map(([name]) => name);
    return { ready: attached.length === Object.keys(requiredCounts).length, expected, attached, labels };
  })()`
}

interface AttachmentDescriptor {
  fsPath: string
  label: string
  path: string
}

type StatLike = (path: string) => Promise<{ isDirectory(): boolean }>

async function attachmentDescriptors(
  filePaths: readonly string[],
  statImpl: StatLike = stat
): Promise<AttachmentDescriptor[]> {
  return Promise.all(
    filePaths.map(async (fsPath) => {
      const metadata = await statImpl(fsPath)
      return {
        fsPath,
        label: basename(fsPath),
        path: metadata.isDirectory() && !fsPath.endsWith("/") ? `${fsPath}/` : fsPath,
      }
    })
  )
}

export interface AttachFilesOptions {
  threadId?: string | null
  timeoutMs?: number | undefined
  statImpl?: StatLike
}

export interface AttachFilesResult {
  files: string[]
  method: "renderer-host-message"
}

export type AttachFiles = (
  connection: CdpConnection,
  filePaths: unknown,
  options?: AttachFilesOptions
) => Promise<AttachFilesResult>

export const attachFilesToComposer: AttachFiles = async (connection, filePaths, options = {}) => {
  const files = checkedFilePaths(filePaths)
  const names = files.map((path) => basename(path))
  const descriptors = await attachmentDescriptors(files, options.statImpl)
  const before = await connection.send("Runtime.evaluate", {
    expression: attachmentVerificationExpression(options.threadId ?? null, []),
    returnByValue: true,
  })
  const baselineLabels = evaluatedValue<{ labels: unknown[] }>(before)?.labels ?? []
  const injected = await connection.send("Runtime.evaluate", {
    expression: attachmentInjectionExpression(options.threadId ?? null, descriptors),
    returnByValue: true,
  })
  const injectionResult = evaluatedValue<{ injected: boolean; reason: string }>(injected)
  if (!injectionResult?.injected) {
    throw new Error(injectionResult?.reason ?? "Codex attachment injection failed")
  }

  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  let verification: Partial<{ ready: boolean }> | null = null
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: attachmentVerificationExpression(options.threadId ?? null, names, baselineLabels),
      returnByValue: true,
    })
    verification = evaluatedValue<{ ready: boolean }>(evaluated)
    if (verification?.ready) break
    await sleep(200)
  }
  if (!verification?.ready) {
    throw new Error(`Codex App did not render attachments: ${JSON.stringify(verification)}`)
  }
  return {
    files: names,
    method: "renderer-host-message",
  }
}

/** What the composer-submit script reports. */
interface ComposerSubmitState {
  composerFound: boolean
  promptMatched: boolean
  submitted: boolean
  reason: string
  method: string
  buttonLabel: string
}

async function submitComposer(
  connection: CdpConnection,
  nonce: string,
  { timeoutMs = 15_000, threadId = null }: { timeoutMs?: number; threadId?: string | null } = {}
): Promise<Partial<ComposerSubmitState>> {
  const deadline = Date.now() + timeoutMs
  let last: Partial<ComposerSubmitState> | null = null
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: composerSubmitExpression(nonce, threadId),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (evaluated.exceptionDetails) throw new Error("Codex composer inspection failed")
    last = evaluatedValue<ComposerSubmitState>(evaluated)
    if (last?.submitted) return last
    if (last?.composerFound) {
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      await connection.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      return { ...last, submitted: true, method: "keyboard" }
    }
    await sleep(200)
  }
  throw new Error(last?.reason ?? "Codex composer did not become ready")
}

function openCodexDeepLink(value: string): void {
  const opened = commandResult("/usr/bin/open", [value], { timeout: 5000 })
  if (!opened.ok) throw new Error(opened.stderr || opened.error || "Unable to open Codex deep link")
}

interface SelectedConversation {
  expected: string
  rendered: string[]
  selected: boolean
}

async function waitForSelectedConversation(
  connection: CdpConnection,
  threadId: string,
  timeoutMs = 15_000
): Promise<Partial<SelectedConversation>> {
  const deadline = Date.now() + timeoutMs
  let last: Partial<SelectedConversation> | null = null
  while (Date.now() < deadline) {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: selectedConversationExpression(threadId),
      returnByValue: true,
    })
    last = evaluatedValue<SelectedConversation>(evaluated)
    if (last?.selected) return last
    await sleep(200)
  }
  throw new Error(
    `Codex App did not select thread ${threadId}; rendered: ${JSON.stringify(last?.rendered ?? [])}`
  )
}

/** Injectable collaborators; production uses the real `open`, CDP discovery and socket. */
export interface CdpDependencies {
  cdpPort?: number
  timeoutMs?: number
  openDeepLink?: (deepLink: string) => void | Promise<void>
  openThread?: (deepLink: string) => void | Promise<void>
  waitForRenderer?: () => Promise<CdpTarget>
  connect?: (webSocketDebuggerUrl: string) => Promise<CdpConnection>
  attachFiles?: AttachFiles
}

export interface BootstrapTaskInput extends CodexTaskDeepLinkInput {
  filePaths?: string[]
}

export async function bootstrapCodexTask(
  input: BootstrapTaskInput,
  dependencies: CdpDependencies = {}
) {
  const deepLink = buildCodexTaskDeepLink(input)
  const cdpPort = dependencies.cdpPort ?? Number(process.env.CODEX_RELAY_CDP_PORT)
  if (dependencies.waitForRenderer == null && !Number.isSafeInteger(cdpPort)) {
    throw new Error("A valid CDP port is required")
  }
  const openDeepLink = dependencies.openDeepLink ?? openCodexDeepLink
  const waitForRenderer = dependencies.waitForRenderer ?? (() => waitForCodexRenderer(cdpPort))
  const connect = dependencies.connect ?? connectCdp

  await openDeepLink(deepLink)
  const renderer = await waitForRenderer()
  const connection = await connect(renderer.webSocketDebuggerUrl)
  try {
    await connection.send("Runtime.enable")
    const attachments = input.filePaths?.length
      ? await (dependencies.attachFiles ?? attachFilesToComposer)(connection, input.filePaths, {
          timeoutMs: dependencies.timeoutMs,
        })
      : null
    const submission = await submitComposer(connection, input.nonce as string)
    return {
      deepLink,
      rendererId: renderer.id,
      rendererUrl: renderer.url ?? null,
      attachments,
      submission,
    }
  } finally {
    connection.close()
  }
}

export interface ComposerPromptInput {
  threadId: string
  prompt: unknown
  nonce: unknown
  filePaths?: string[]
}

export async function submitCodexComposerPrompt(
  input: ComposerPromptInput,
  dependencies: CdpDependencies = {}
) {
  const prompt = requiredString(input.prompt, "prompt")
  const nonce = requiredString(input.nonce, "nonce", { maxLength: 128 })
  const threadDeepLink = buildCodexThreadDeepLink(input.threadId)
  const threadId = input.threadId
  if (!/^[A-Za-z0-9._-]+$/.test(nonce)) throw new Error("nonce contains unsupported characters")
  const cdpPort = dependencies.cdpPort ?? Number(process.env.CODEX_RELAY_CDP_PORT)
  if (dependencies.waitForRenderer == null && !Number.isSafeInteger(cdpPort)) {
    throw new Error("A valid CDP port is required")
  }
  await (dependencies.openThread ?? openCodexDeepLink)(threadDeepLink)
  const renderer = await (dependencies.waitForRenderer ?? (() => waitForCodexRenderer(cdpPort)))()
  const connection = await (dependencies.connect ?? connectCdp)(renderer.webSocketDebuggerUrl)
  try {
    await connection.send("Runtime.enable")
    const selection = await waitForSelectedConversation(
      connection,
      threadId,
      dependencies.timeoutMs ?? 15_000
    )
    const deadline = Date.now() + (dependencies.timeoutMs ?? 15_000)
    let focused: Partial<{ empty: boolean }> | null = null
    while (Date.now() < deadline) {
      const evaluated = await connection.send("Runtime.evaluate", {
        expression: focusComposerExpression(threadId),
        returnByValue: true,
        userGesture: true,
      })
      focused = evaluatedValue<{ empty: boolean }>(evaluated)
      if (focused?.empty) break
      await sleep(200)
    }
    if (!focused?.empty) throw new Error("Codex composer is not ready for a follow-up")
    const attachments = input.filePaths?.length
      ? await (dependencies.attachFiles ?? attachFilesToComposer)(connection, input.filePaths, {
          threadId,
          timeoutMs: dependencies.timeoutMs,
        })
      : null
    if (attachments) {
      const refocused = await connection.send("Runtime.evaluate", {
        expression: focusComposerExpression(threadId),
        returnByValue: true,
        userGesture: true,
      })
      if (!evaluatedValue<{ empty: boolean }>(refocused)?.empty) {
        throw new Error("Codex composer lost its safe draft state after attaching files")
      }
    }
    await connection.send("Input.insertText", {
      text: `${prompt}\n\n[${BOOTSTRAP_MARKER_PREFIX}${nonce}]`,
    })
    const submission = await submitComposer(connection, nonce, { threadId })
    return {
      threadId,
      threadDeepLink,
      selection,
      rendererId: renderer.id,
      rendererUrl: renderer.url ?? null,
      attachments,
      submission,
    }
  } finally {
    connection.close()
  }
}

async function withSelectedThread<T extends object>(
  input: { threadId: string },
  dependencies: CdpDependencies,
  action: (connection: CdpConnection, threadId: string) => Promise<T>
) {
  const threadId = input.threadId
  const threadDeepLink = buildCodexThreadDeepLink(threadId)
  const cdpPort = dependencies.cdpPort ?? Number(process.env.CODEX_RELAY_CDP_PORT)
  if (dependencies.waitForRenderer == null && !Number.isSafeInteger(cdpPort)) {
    throw new Error("A valid CDP port is required")
  }
  await (dependencies.openThread ?? openCodexDeepLink)(threadDeepLink)
  const renderer = await (dependencies.waitForRenderer ?? (() => waitForCodexRenderer(cdpPort)))()
  const connection = await (dependencies.connect ?? connectCdp)(renderer.webSocketDebuggerUrl)
  try {
    await connection.send("Runtime.enable")
    const selection = await waitForSelectedConversation(
      connection,
      threadId,
      dependencies.timeoutMs ?? 15_000
    )
    const result = await action(connection, threadId)
    return {
      threadId,
      threadDeepLink,
      rendererId: renderer.id,
      rendererUrl: renderer.url ?? null,
      selection,
      ...result,
    }
  } finally {
    connection.close()
  }
}

export async function openCodexTask(
  input: { threadId: string },
  dependencies: CdpDependencies = {}
) {
  return withSelectedThread(input, dependencies, async () => ({ opened: true }))
}

export async function interruptCodexTask(
  input: { threadId: string },
  dependencies: CdpDependencies = {}
) {
  return withSelectedThread(input, dependencies, async (connection, threadId) => {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: `(() => {
        const expected = ${JSON.stringify(input.threadId)};
        const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
          .map((element) => element.getAttribute('data-response-annotation-conversation'));
        if (!rendered.includes(expected)) return { interrupted: false, reason: 'wrong_conversation' };
        const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
        const candidates = [...document.querySelectorAll('button[aria-label="Stop"]')].filter(visible);
        if (candidates.length !== 1) return { interrupted: false, reason: candidates.length ? 'ambiguous_stop' : 'not_running' };
        candidates[0].click();
        return { interrupted: true };
      })()`,
      returnByValue: true,
      userGesture: true,
    })
    const interruption = evaluatedValue<{ interrupted: boolean; reason: string }>(evaluated)
    if (!interruption?.interrupted && interruption?.reason !== "not_running") {
      throw new Error(interruption?.reason ?? "unable to interrupt task")
    }
    return { threadId, interruption }
  })
}

function composerContextExpression(threadId: string, actionLabel: string | null = null): string {
  return `(async () => {
    const expected = ${JSON.stringify(threadId)};
    const action = ${JSON.stringify(actionLabel)};
    const rendered = [...document.querySelectorAll('[data-response-annotation-conversation]')]
      .map((element) => element.getAttribute('data-response-annotation-conversation'));
    if (!rendered.includes(expected)) return { ready: false, reason: 'wrong_conversation' };
    const visible = (element) => { const rect = element?.getBoundingClientRect(); return Boolean(rect?.width && rect?.height); };
    const exactLeaf = (text) => [...document.querySelectorAll('span,div')]
      .find((element) => element.childElementCount === 0 && element.textContent?.trim() === text && visible(element));
    let filesButton = exactLeaf('Files and folders')?.closest('button');
    const composer = [...document.querySelectorAll('[data-codex-composer="true"]')].filter(visible).at(-1);
    const scope = composer?.closest('[data-composer-layout]') || composer?.closest('form') || document;
    const addButton = [...scope.querySelectorAll('button')]
      .find((element) => element.getAttribute('data-composer-navigation-target') === 'add-context' && visible(element));
    if (!filesButton && addButton) {
      addButton.click();
      for (let index = 0; index < 30 && !filesButton; index += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        filesButton = exactLeaf('Files and folders')?.closest('button');
      }
    }
    if (!filesButton) return { ready: false, reason: 'context_menu_not_found' };
    const menu = filesButton.parentElement?.parentElement;
    if (!menu) return { ready: false, reason: 'context_menu_not_found' };
    const items = [...menu.querySelectorAll('button')].filter(visible).map((button) => {
      const lines = (button.innerText || button.textContent || '').split('\\n').map((value) => value.trim()).filter(Boolean);
      return { label: lines[0] || '', description: lines.slice(1).join(' ') || null };
    }).filter((item) => item.label);
    if (action) {
      if (action === 'Files and folders') return { ready: false, reason: 'use_attachment_command' };
      const leaf = exactLeaf(action);
      const button = leaf?.closest('button');
      if (!button || !menu.contains(button)) return { ready: false, reason: 'context_not_found', items };
      button.click();
      return { ready: true, invoked: action, items };
    }
    addButton?.click();
    return { ready: true, items };
  })()`
}

/** A "+" composer context entry (Files and folders, installed plugin contexts, …). */
export interface ComposerContextItem {
  label: string
  description: string | null
}

export async function listCodexComposerContexts(
  input: { threadId: string },
  dependencies: CdpDependencies = {}
) {
  return withSelectedThread(input, dependencies, async (connection, threadId) => {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: composerContextExpression(threadId),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    const contexts = evaluatedValue<{
      ready: boolean
      reason: string
      items: ComposerContextItem[]
    }>(evaluated)
    if (!contexts?.ready) throw new Error(contexts?.reason ?? "unable to list composer contexts")
    return { contexts: contexts.items }
  })
}

export async function invokeCodexComposerContext(
  input: { threadId: string; label: unknown },
  dependencies: CdpDependencies = {}
) {
  const label = requiredString(input.label, "label", { maxLength: 160 })
  return withSelectedThread(input, dependencies, async (connection, threadId) => {
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: composerContextExpression(threadId, label),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    const context = evaluatedValue<{
      ready: boolean
      reason: string
      invoked: string
      items: ComposerContextItem[]
    }>(evaluated)
    if (!context?.ready) throw new Error(context?.reason ?? "unable to invoke composer context")
    return { context: { invoked: context.invoked, available: context.items } }
  })
}
