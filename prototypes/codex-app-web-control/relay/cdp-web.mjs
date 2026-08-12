#!/usr/bin/env node

/**
 * PROTOTYPE — loopback Web controller for a normally-owned Codex App runtime.
 * Commands enter through the App renderer; display state is mirrored from rollout JSONL.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
import { unlink } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { createAttachmentStore } from "./attachment-store.mjs"
import {
  attachCodexTaskFiles,
  bootstrapCodexTask,
  discoverCodexRenderer,
  interruptCodexTask,
  invokeCodexComposerContext,
  listCodexComposerContexts,
  openCodexTask,
  submitCodexComposerPrompt,
} from "./cdp-bootstrap.mjs"
import { createCommandRegistry } from "./command-registry.mjs"
import { ensureCodexCdpRuntime } from "./cdp-runtime.mjs"
import { inspectTcpListener } from "./listener-safety.mjs"
import { selectNativeFolder } from "./native-folder-picker.mjs"
import {
  findRolloutByMarker,
  findRolloutByThreadId,
  readProjectedRollout,
} from "./rollout-mirror.mjs"
import {
  corsHeadersForOrigin,
  ensurePrivateDirectory,
  relayPaths,
  waitFor,
  writeJsonAtomic,
} from "./shared.mjs"
import { listCodexTasks } from "./task-index.mjs"

const argv = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
const host = "127.0.0.1"
const webPort = Number(valueAfter("--web-port", "4317"))
const cdpPort = Number(valueAfter("--cdp-port", "9229"))
const cdpReadyTimeoutMs = Number(valueAfter("--cdp-ready-timeout-ms", "60000"))
const autoRestart = !argv.includes("--no-auto-restart")
const launchdService = argv.includes("--launchd-service")
const launchId = valueAfter("--launch-id", null)
const stateDir = valueAfter("--state-dir", process.env.CODEX_RELAY_STATE_DIR)
const paths = relayPaths(stateDir)
const relayDirectory = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(
  valueAfter(
    "--workspace",
    process.env.CODEX_RELAY_WORKSPACE ?? resolve(relayDirectory, "../../..")
  )
)
const sessionsRoot = join(homedir(), ".codex", "sessions")
for (const [name, value] of [
  ["web-port", webPort],
  ["cdp-port", cdpPort],
]) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
}
if (
  !Number.isSafeInteger(cdpReadyTimeoutMs) ||
  cdpReadyTimeoutMs < 15_000 ||
  cdpReadyTimeoutMs > 180_000
) {
  throw new Error(`Invalid cdp-ready-timeout-ms: ${cdpReadyTimeoutMs}`)
}

const token = randomBytes(32).toString("base64url")
const pairingCode = randomBytes(18).toString("base64url")
const allowedOrigins = new Set(
  (process.env.COGNIA_WEB_ALLOWED_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
)
const listeners = new Set()
const attachmentStore = createAttachmentStore()
let nextSequence = 0
const state = {
  mode: "normal-app-cdp-rollout-mirror",
  cdpPort,
  workspace,
  task: null,
  cdpRecovery: { status: "not-checked", at: new Date().toISOString() },
  events: [],
  lastError: null,
}

function secureEqual(actual, expected) {
  if (typeof actual !== "string") return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function authenticated(request, url) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  return secureEqual(bearer, token) || secureEqual(url.searchParams.get("token"), token)
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  response.end(JSON.stringify(value))
}

async function readJsonBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > 256 * 1024) throw new Error("request body exceeds 256 KiB")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object")
  }
  return value
}

function publish(type, payload) {
  if (type === "command/completed") state.lastError = null
  const event = { seq: ++nextSequence, at: new Date().toISOString(), type, payload }
  state.events.push(event)
  if (state.events.length > 500) state.events.shift()
  for (const listener of listeners) listener(event)
}

async function refreshRollout() {
  if (!state.task?.rolloutPath) return
  const projected = await readProjectedRollout(state.task.rolloutPath)
  const previousLength = state.task.projectedLength ?? 0
  for (const event of projected.slice(previousLength)) publish("rollout", event)
  state.task.projectedLength = projected.length
  const session = projected.find((event) => event.kind === "session")
  if (session?.threadId) state.task.threadId = session.threadId
}

setInterval(() => {
  refreshRollout().catch((error) => {
    state.lastError = error instanceof Error ? error.message : String(error)
  })
}, 750).unref()

async function cdpHealth() {
  const renderer = await discoverCodexRenderer(cdpPort)
  const listener = inspectTcpListener(cdpPort)
  return {
    ready: Boolean(renderer) && listener.loopbackOnly,
    renderer: renderer ? { id: renderer.id, url: renderer.url } : null,
    listener,
  }
}

let recoveryPromise = null

async function ensureRuntimeReady() {
  if (recoveryPromise) return recoveryPromise
  const attempt = ensureCodexCdpRuntime({
    cdpPort,
    stateDir,
    timeoutMs: cdpReadyTimeoutMs,
    autoRestart,
    onStatus(status, details) {
      state.cdpRecovery = {
        status,
        at: new Date().toISOString(),
        restarted: details.restarted ?? state.cdpRecovery.restarted ?? false,
        currentAppPids: details.currentAppPids ?? details.pids ?? null,
        error: details.cause ?? details.error ?? null,
      }
      process.stderr.write(`Codex CDP runtime: ${status}\n`)
    },
  })
  recoveryPromise = attempt
  try {
    return await attempt
  } finally {
    if (recoveryPromise === attempt) recoveryPromise = null
  }
}

async function withCdpRuntime(operation) {
  await ensureRuntimeReady()
  return operation()
}

function requiredText(value, name, maxLength = 16_000) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`)
  if (value.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`)
  return value.trim()
}

function selectedThreadId(input) {
  return requiredText(input.threadId ?? state.task?.threadId, "threadId", 64)
}

function attachmentInput(input) {
  const attachments = attachmentStore.resolveIds(input.attachmentIds ?? [])
  return {
    attachmentIds: attachments.map((attachment) => attachment.id),
    filePaths: attachments.map((attachment) => attachment.path),
  }
}

async function attachMirror(rolloutPath, details = {}) {
  state.events.length = 0
  const projected = await readProjectedRollout(rolloutPath)
  const session = projected.find((event) => event.kind === "session")
  if (!session?.threadId) throw new Error("rollout does not contain a canonical thread id")
  state.task = {
    threadId: session.threadId,
    rolloutPath,
    projectedLength: 0,
    ...details,
  }
  await refreshRollout()
  publish("task/attached", {
    threadId: state.task.threadId,
    rolloutPath: state.task.rolloutPath,
    source: details.source ?? "app",
  })
  return state.task
}

async function createTask(input) {
  await ensureRuntimeReady()
  const prompt = requiredText(input.prompt, "prompt")
  const browserUrl = String(input.browserUrl ?? `http://${host}:${webPort}/browser-target`)
  const attachments = attachmentInput(input)
  const nonce = randomBytes(12).toString("hex")
  const marker = `COGNIA_BOOTSTRAP:${nonce}`
  const sinceMs = Date.now() - 2_000
  const bootstrap = await bootstrapCodexTask(
    { prompt, browserUrl, workspace, nonce, filePaths: attachments.filePaths },
    { cdpPort }
  )
  const rolloutPath = await waitFor(() => findRolloutByMarker(sessionsRoot, marker, { sinceMs }), {
    timeoutMs: 60_000,
    intervalMs: 500,
    description: "App-owned rollout file",
  })
  return attachMirror(rolloutPath, {
    nonce,
    bootstrap,
    source: "created",
    attachmentIds: attachments.attachmentIds,
  })
}

const inputSchemas = {
  thread: {
    type: "object",
    properties: { threadId: { type: "string", description: "Canonical Codex task UUID" } },
  },
  attachments: {
    type: "array",
    items: { type: "string" },
    maxItems: attachmentStore.maxFiles,
  },
}

async function listTasks(input = {}) {
  const result = await listCodexTasks({
    limit: input.limit ?? 50,
    query: input.query ?? "",
    archived: input.archived ?? "active",
    scope: input.scope ?? "workspace",
    includeSubagents: input.includeSubagents === true,
    cursor: input.cursor ?? null,
    workspace,
  })
  return {
    ...result,
    workspace,
    selectedThreadId: state.task?.threadId ?? null,
    tasks: result.tasks.map((task) => ({
      ...task,
      selected: task.id === state.task?.threadId,
    })),
  }
}

const commands = createCommandRegistry(
  [
    {
      id: "runtime.status",
      title: "Runtime status",
      description: "Read the local Codex App, task, attachment, and relay status.",
      scope: "runtime",
      mutates: false,
      inputSchema: { type: "object" },
      execute: async () => ({
        ...state,
        attachments: attachmentStore.list(),
        health: await cdpHealth(),
      }),
    },
    {
      id: "attachment.list",
      title: "List attachments",
      description: "List files uploaded into the private local relay cache.",
      scope: "attachment",
      mutates: false,
      inputSchema: { type: "object" },
      execute: async () => ({ attachments: attachmentStore.list() }),
    },
    {
      id: "attachment.delete",
      title: "Delete attachment",
      description: "Delete one cached attachment by id.",
      scope: "attachment",
      inputSchema: {
        type: "object",
        required: ["attachmentId"],
        properties: { attachmentId: { type: "string" } },
      },
      validate: (input) => ({ attachmentId: requiredText(input.attachmentId, "attachmentId", 64) }),
      execute: async ({ attachmentId }) => ({
        attachmentId,
        removed: await attachmentStore.remove(attachmentId),
      }),
    },
    {
      id: "task.list",
      title: "List tasks",
      description:
        "List canonical task UUIDs and titles from the read-only local Codex task index.",
      scope: "task",
      mutates: false,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          query: { type: "string", description: "Search UUID, title, preview, or workspace" },
          archived: { type: "string", enum: ["active", "archived", "all"] },
          scope: { type: "string", enum: ["workspace", "all"] },
          includeSubagents: { type: "boolean", default: false },
          cursor: { type: ["string", "null"] },
        },
      },
      execute: listTasks,
    },
    {
      id: "task.create",
      title: "Create task",
      description:
        "Create and submit a new App-owned task, with optional Browser context and files.",
      scope: "task",
      supportsAttachments: true,
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          browserUrl: { type: "string", format: "uri" },
          attachmentIds: inputSchemas.attachments,
        },
      },
      execute: createTask,
    },
    {
      id: "task.select",
      title: "Select existing task",
      description: "Bind the mirror to an existing canonical task and open it in Codex App.",
      scope: "task",
      inputSchema: { ...inputSchemas.thread, required: ["threadId"] },
      validate: (input) => ({ threadId: requiredText(input.threadId, "threadId", 64) }),
      execute: async ({ threadId }) => {
        const rolloutPath = await findRolloutByThreadId(sessionsRoot, threadId)
        if (!rolloutPath) throw new Error(`App-owned rollout not found for task ${threadId}`)
        const opened = await withCdpRuntime(() => openCodexTask({ threadId }, { cdpPort }))
        await attachMirror(rolloutPath, { source: "selected" })
        return { opened, task: state.task }
      },
    },
    {
      id: "task.open",
      title: "Open task",
      description: "Open and verify the exact canonical task in Codex App.",
      scope: "task",
      inputSchema: inputSchemas.thread,
      validate: (input) => ({ threadId: selectedThreadId(input) }),
      execute: (input) => withCdpRuntime(() => openCodexTask(input, { cdpPort })),
    },
    {
      id: "task.send",
      title: "Send message",
      description: "Send a thread-bound follow-up through the App composer, with optional files.",
      scope: "task",
      supportsAttachments: true,
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          threadId: inputSchemas.thread.properties.threadId,
          prompt: { type: "string" },
          attachmentIds: inputSchemas.attachments,
        },
      },
      validate: (input) => ({
        threadId: selectedThreadId(input),
        prompt: requiredText(input.prompt, "prompt"),
        ...attachmentInput(input),
      }),
      execute: (input) =>
        withCdpRuntime(() =>
          submitCodexComposerPrompt(
            { ...input, nonce: randomBytes(12).toString("hex") },
            { cdpPort }
          )
        ),
    },
    {
      id: "task.attach",
      title: "Attach files",
      description: "Attach cached files to the exact task composer without submitting it.",
      scope: "task",
      supportsAttachments: true,
      inputSchema: {
        type: "object",
        required: ["attachmentIds"],
        properties: {
          threadId: inputSchemas.thread.properties.threadId,
          attachmentIds: inputSchemas.attachments,
        },
      },
      validate: (input) => ({ threadId: selectedThreadId(input), ...attachmentInput(input) }),
      execute: (input) => withCdpRuntime(() => attachCodexTaskFiles(input, { cdpPort })),
    },
    {
      id: "task.interrupt",
      title: "Interrupt task",
      description: "Click only the exact Stop control for the verified task.",
      scope: "task",
      destructive: true,
      inputSchema: inputSchemas.thread,
      validate: (input) => ({ threadId: selectedThreadId(input) }),
      execute: (input) => withCdpRuntime(() => interruptCodexTask(input, { cdpPort })),
    },
    {
      id: "composer.context.list",
      title: "List App contexts",
      description:
        "Discover the current Add menu, including installed plugins, Goal, and Plan mode.",
      scope: "composer",
      inputSchema: inputSchemas.thread,
      validate: (input) => ({ threadId: selectedThreadId(input) }),
      execute: (input) => withCdpRuntime(() => listCodexComposerContexts(input, { cdpPort })),
    },
    {
      id: "composer.context.invoke",
      title: "Invoke App context",
      description: "Invoke an exact item discovered from the current App Add menu.",
      scope: "composer",
      inputSchema: {
        type: "object",
        required: ["label"],
        properties: {
          threadId: inputSchemas.thread.properties.threadId,
          label: { type: "string" },
        },
      },
      validate: (input) => ({
        threadId: selectedThreadId(input),
        label: requiredText(input.label, "label", 160),
      }),
      execute: (input) => withCdpRuntime(() => invokeCodexComposerContext(input, { cdpPort })),
    },
  ],
  { publish }
)

const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cognia Codex App control</title>
<style>
*{box-sizing:border-box}body{font:14px/1.5 system-ui;margin:0;background:#0b1020;color:#e7ebf3}main{max-width:1100px;margin:auto;padding:24px}section{background:#151c30;border:1px solid #2b3550;border-radius:12px;padding:16px;margin:12px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row>input,.row>select{flex:1;min-width:150px}.inline-check{display:flex;gap:6px;align-items:center;white-space:nowrap}.inline-check input{width:auto}input,textarea,button,select{font:inherit}input,textarea,select{width:100%;padding:9px;background:#0d1426;color:inherit;border:1px solid #35415f;border-radius:8px;margin:5px 0}button{padding:9px 14px;border:0;border-radius:8px;background:#6d7cff;color:white;cursor:pointer}button.secondary{background:#35415f}button.danger{background:#b64f5c}button:disabled{opacity:.5}.task-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:10px 0;border-bottom:1px solid #2b3550}.task-row.selected{border-left:3px solid #6d7cff;padding-left:10px}.task-title{font-weight:600;overflow-wrap:anywhere}.task-meta{font-size:12px;color:#9da8bf;overflow-wrap:anywhere}.task-actions{display:flex;gap:6px;align-items:center}.task-actions button{padding:6px 9px}.attachment{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:7px;border-bottom:1px solid #2b3550}.attachment input{width:auto}.directory-picker{display:flex;align-items:center;gap:10px;margin:8px 0 12px}.directory-status{min-width:0;overflow-wrap:anywhere}.event{white-space:pre-wrap;border-left:3px solid #53617f;padding:8px 12px;margin:8px 0;overflow-wrap:anywhere}.user{border-color:#6d7cff}.assistant{border-color:#45c486}.tool{border-color:#e6a84b}code{color:#9fddff}.muted{color:#9da8bf}@media(max-width:760px){.grid{grid-template-columns:1fr}.task-row{grid-template-columns:1fr}}
</style></head>
<body><main><h1>Cognia ↔ normal Codex App</h1><p class="muted">One App-owned runtime · native attachments · discoverable commands · installed App contexts</p>
<section><strong id="health">Connecting…</strong><div id="task"></div><div class="row"><input id="threadId" placeholder="Canonical task UUID"><button id="selectTask" class="secondary">Select existing task</button><button id="openTask" class="secondary">Open</button><button id="stopTask" class="danger">Stop</button></div></section>
<section><h2>Codex task index</h2><p class="muted">Read-only UUID ↔ title mapping from the App's local task index.</p><div class="row"><input id="taskQuery" placeholder="Search title, UUID, preview, or workspace"><select id="taskScope"><option value="workspace">Current workspace</option><option value="all">All workspaces</option></select><select id="taskArchived"><option value="active">Active</option><option value="archived">Archived</option><option value="all">Active + archived</option></select><label class="inline-check"><input id="taskSubagents" type="checkbox">Include subagents</label><button id="refreshTasks" class="secondary">Refresh</button></div><div id="taskList" class="muted">Loading tasks…</div><div class="row"><span id="taskCount" class="muted"></span><button id="moreTasks" class="secondary" hidden>Load more</button></div></section>
<div class="grid"><section><h2>Attachments</h2><label>Files<input id="files" type="file" multiple></label><div class="directory-picker"><button id="chooseFolder" type="button" class="secondary">Choose one local folder</button><span id="folderUploadStatus" class="directory-status muted">Uses the native folder picker; the browser never uploads a directory.</span></div><div id="attachments" class="muted">No cached attachments.</div><button id="attachOnly" class="secondary">Attach checked files or folders without sending</button></section>
<section><h2>App contexts and plugins</h2><div class="row"><button id="loadContexts" class="secondary">Discover current Add menu</button><select id="contexts"><option value="">No contexts loaded</option></select><button id="invokeContext">Invoke exact item</button></div><pre id="contextResult" class="muted"></pre></section></div>
<section><form id="new"><h2>New App-owned task</h2><label>Prompt<textarea name="prompt" required>Use the Browser plugin and inspect the opened page.</textarea></label><label>Browser URL<input name="browserUrl" value="http://127.0.0.1:${webPort}/browser-target"></label><button>Start with checked attachments</button></form></section>
<section><form id="follow"><h2>Thread-bound message</h2><label>Prompt<textarea name="prompt" required></textarea></label><button>Send with checked attachments</button></form></section>
<section><h2>Complete command interface</h2><p class="muted">Every supported mutation is exposed through the same typed command envelope and lifecycle events.</p><select id="command"></select><textarea id="commandInput" rows="6">{}</textarea><div class="row"><button id="executeCommand">Execute command</button><code id="commandResult"></code></div></section>
<section><h2>Mirrored App events</h2><div id="events"></div></section></main><script>
const token=location.hash.slice(1);const auth={Authorization:'Bearer '+token};const jsonHeaders={...auth,'Content-Type':'application/json'};
const esc=(value)=>String(value??'').replace(/[&<>]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
const healthElement=document.querySelector('#health');const taskElement=document.querySelector('#task');const eventsElement=document.querySelector('#events');const attachmentElement=document.querySelector('#attachments');const threadElement=document.querySelector('#threadId');const taskListElement=document.querySelector('#taskList');let commandMetadata=[];let taskCursor=null;let loadedTasks=[];
async function request(path,options={}){const response=await fetch(path,{...options,headers:{...jsonHeaders,...options.headers}});const payload=await response.json().catch(()=>({}));if(!response.ok)throw Error(payload.error||response.statusText);return payload}
async function run(command,input={}){const payload=await request('/api/commands/execute',{method:'POST',body:JSON.stringify({command,input})});document.querySelector('#commandResult').textContent=JSON.stringify(payload.result);await refresh();return payload.result}
function checkedAttachments(){return [...document.querySelectorAll('[data-attachment]:checked')].map((input)=>input.value)}
function renderAttachment(item){const details=item.kind==='folder'?item.fileCount+' files · '+item.size+' bytes':item.size+' bytes · '+item.mimeType;return '<label class="attachment"><input type="checkbox" data-attachment value="'+esc(item.id)+'" checked><span>'+esc(item.name)+' <small class="muted">'+esc(item.kind)+' · '+esc(details)+'</small></span><button type="button" class="danger" data-remove="'+esc(item.id)+'">Delete</button></label>'}
async function refreshAttachments(){const payload=await request('/api/attachments');attachmentElement.innerHTML=payload.attachments.length?payload.attachments.map(renderAttachment).join(''):'No cached attachments.'}
function render(event){const payload=event.payload||{};const cls=payload.role||payload.kind||'';eventsElement.insertAdjacentHTML('beforeend','<div class="event '+esc(cls)+'"><b>'+esc(event.type)+'</b> '+esc(payload.role||payload.status||payload.command||payload.name||'')+'<br>'+esc(payload.text||payload.lastAgentMessage||payload.input||payload.output||JSON.stringify(payload))+'</div>')}
async function refresh(){const payload=await request('/api/status');healthElement.textContent=payload.health?.ready?'CDP ready · normal App runtime':'Unavailable';const id=payload.task?.threadId||'';taskElement.textContent=id?'Mirroring task '+id:'No task selected';if(id&&!threadElement.value)threadElement.value=id}
function renderTask(item){const status=[item.pinned?'pinned':null,item.archived?'archived':null,item.model,item.cwd,item.recencyAt].filter(Boolean).join(' · ');return '<div class="task-row '+(item.selected?'selected':'')+'"><div><div class="task-title">'+esc(item.title)+'</div><code>'+esc(item.id)+'</code><div class="task-meta">'+esc(status)+'</div><div class="task-meta">'+esc(item.preview)+'</div></div><div class="task-actions"><button class="secondary" data-copy-task="'+item.id+'">Copy UUID</button><button data-select-task="'+item.id+'">Select</button></div></div>'}
async function loadTasks({append=false}={}){const button=document.querySelector('#refreshTasks');button.disabled=true;try{const params=new URLSearchParams({limit:'50',query:document.querySelector('#taskQuery').value,scope:document.querySelector('#taskScope').value,archived:document.querySelector('#taskArchived').value,includeSubagents:String(document.querySelector('#taskSubagents').checked)});if(append&&taskCursor)params.set('cursor',taskCursor);const result=await request('/api/tasks?'+params);loadedTasks=append?loadedTasks.concat(result.tasks):result.tasks;taskCursor=result.nextCursor;taskListElement.innerHTML=loadedTasks.length?loadedTasks.map(renderTask).join(''):'No matching tasks.';document.querySelector('#taskCount').textContent=loadedTasks.length+' of '+result.total+' tasks · '+result.source;document.querySelector('#moreTasks').hidden=!taskCursor}catch(error){taskListElement.textContent=error.message}finally{button.disabled=false}}
taskListElement.onclick=async(event)=>{const selectId=event.target?.dataset?.selectTask;const copyId=event.target?.dataset?.copyTask;if(copyId){await navigator.clipboard.writeText(copyId);event.target.textContent='Copied';return}if(!selectId)return;threadElement.value=selectId;try{await run('task.select',{threadId:selectId});await loadTasks()}catch(error){alert(error.message)}};
document.querySelector('#refreshTasks').onclick=()=>{taskCursor=null;loadTasks()};document.querySelector('#moreTasks').onclick=()=>loadTasks({append:true});document.querySelector('#taskQuery').onkeydown=(event)=>{if(event.key==='Enter'){event.preventDefault();taskCursor=null;loadTasks()}};document.querySelector('#taskScope').onchange=()=>loadTasks();document.querySelector('#taskArchived').onchange=()=>loadTasks();document.querySelector('#taskSubagents').onchange=()=>loadTasks();
document.querySelector('#files').onchange=async(event)=>{const input=event.currentTarget;input.disabled=true;try{for(const file of input.files){await request('/api/attachments',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-Attachment-Name':encodeURIComponent(file.name),'X-Attachment-Size':String(file.size)},body:file})}await refreshAttachments();input.value=''}catch(error){alert(error.message)}finally{input.disabled=false}};
const chooseFolderButton=document.querySelector('#chooseFolder');const folderUploadStatus=document.querySelector('#folderUploadStatus');chooseFolderButton.onclick=async()=>{chooseFolderButton.disabled=true;folderUploadStatus.textContent='Waiting for native folder selection…';try{const folder=await request('/api/attachment-folders/select',{method:'POST'});if(folder.cancelled){folderUploadStatus.textContent='Folder selection cancelled';return}folderUploadStatus.textContent=folder.name+' added as one folder attachment';await refreshAttachments()}catch(error){folderUploadStatus.textContent='Folder selection failed';alert(error.message)}finally{chooseFolderButton.disabled=false}};
attachmentElement.onclick=async(event)=>{const id=event.target?.dataset?.remove;if(!id)return;try{await request('/api/attachments/'+encodeURIComponent(id),{method:'DELETE'});await refreshAttachments()}catch(error){alert(error.message)}};
document.querySelector('#new').onsubmit=async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const input=Object.fromEntries(new FormData(event.target));input.attachmentIds=checkedAttachments();await run('task.create',input)}catch(error){alert(error.message)}finally{button.disabled=false}};
document.querySelector('#follow').onsubmit=async(event)=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const input=Object.fromEntries(new FormData(event.target));input.threadId=threadElement.value;input.attachmentIds=checkedAttachments();await run('task.send',input)}catch(error){alert(error.message)}finally{button.disabled=false}};
document.querySelector('#selectTask').onclick=()=>run('task.select',{threadId:threadElement.value}).catch((error)=>alert(error.message));document.querySelector('#openTask').onclick=()=>run('task.open',{threadId:threadElement.value}).catch((error)=>alert(error.message));document.querySelector('#stopTask').onclick=()=>run('task.interrupt',{threadId:threadElement.value}).catch((error)=>alert(error.message));document.querySelector('#attachOnly').onclick=()=>run('task.attach',{threadId:threadElement.value,attachmentIds:checkedAttachments()}).catch((error)=>alert(error.message));
document.querySelector('#loadContexts').onclick=async()=>{try{const result=await run('composer.context.list',{threadId:threadElement.value});const select=document.querySelector('#contexts');select.innerHTML=result.contexts.map((item)=>'<option value="'+esc(item.label)+'">'+esc(item.label)+(item.description?' — '+esc(item.description):'')+'</option>').join('');document.querySelector('#contextResult').textContent=JSON.stringify(result.contexts,null,2)}catch(error){alert(error.message)}};
document.querySelector('#invokeContext').onclick=()=>run('composer.context.invoke',{threadId:threadElement.value,label:document.querySelector('#contexts').value}).catch((error)=>alert(error.message));
async function loadCommands(){commandMetadata=await request('/api/commands');const select=document.querySelector('#command');select.innerHTML=commandMetadata.map((item)=>'<option value="'+esc(item.id)+'">'+esc(item.id)+' — '+esc(item.title)+'</option>').join('');select.onchange=()=>{const command=commandMetadata.find((item)=>item.id===select.value);document.querySelector('#commandInput').value=JSON.stringify(command?.inputSchema?.required?.reduce((value,key)=>({...value,[key]:''}),{})||{},null,2)};select.onchange()}
document.querySelector('#executeCommand').onclick=()=>{try{run(document.querySelector('#command').value,JSON.parse(document.querySelector('#commandInput').value)).catch((error)=>alert(error.message))}catch(error){alert(error.message)}};
const stream=new EventSource('/api/events?token='+encodeURIComponent(token));stream.addEventListener('snapshot',(event)=>{eventsElement.innerHTML='';JSON.parse(event.data).forEach(render)});stream.addEventListener('mirror',(event)=>render(JSON.parse(event.data)));Promise.all([refresh(),refreshAttachments(),loadCommands(),loadTasks()]).catch((error)=>alert(error.message));
</script></body></html>`

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${webPort}`)
  const cors = corsHeadersForOrigin(allowedOrigins, request.headers.origin)
  try {
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      response.end(html)
      return
    }
    if (request.method === "GET" && url.pathname === "/browser-target") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      response.end(
        `<!doctype html><title>Cognia Browser target</title><main><h1>Browser Use verification</h1><p id="code">${randomBytes(8).toString("hex").toUpperCase()}</p></main>`
      )
      return
    }
    if (url.pathname === "/api/pair" && request.method === "POST") {
      if (!cors["access-control-allow-origin"])
        return sendJson(response, 403, { error: "origin_not_allowed" })
      if (!secureEqual(request.headers["x-cognia-pairing-code"], pairingCode)) {
        return sendJson(response, 401, { error: "invalid_pairing_code" }, cors)
      }
      return sendJson(
        response,
        200,
        { baseUrl: `http://${host}:${webPort}`, token, commandEndpoint: "/api/commands/execute" },
        cors
      )
    }
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      response.writeHead(cors["access-control-allow-origin"] ? 204 : 403, cors)
      response.end()
      return
    }
    if (!url.pathname.startsWith("/api/") || !authenticated(request, url)) {
      return sendJson(response, 401, { error: "unauthorized" }, cors)
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const result = await commands.execute({ command: "runtime.status" })
      return sendJson(response, 200, result.result, cors)
    }
    if (request.method === "GET" && url.pathname === "/api/commands") {
      return sendJson(response, 200, commands.list(), cors)
    }
    if (request.method === "GET" && url.pathname === "/api/tasks") {
      const result = await commands.execute({
        command: "task.list",
        input: {
          limit: url.searchParams.get("limit") ?? 50,
          query: url.searchParams.get("query") ?? "",
          archived: url.searchParams.get("archived") ?? "active",
          scope: url.searchParams.get("scope") ?? "workspace",
          includeSubagents: url.searchParams.get("includeSubagents") === "true",
          cursor: url.searchParams.get("cursor"),
        },
      })
      return sendJson(response, 200, result.result, cors)
    }
    if (request.method === "POST" && url.pathname === "/api/commands/execute") {
      const result = await commands.execute(await readJsonBody(request))
      return sendJson(response, 200, result, cors)
    }
    if (request.method === "GET" && url.pathname === "/api/attachments") {
      return sendJson(response, 200, { attachments: attachmentStore.list() }, cors)
    }
    if (request.method === "POST" && url.pathname === "/api/attachments") {
      const attachment = await attachmentStore.upload(request, {
        name: request.headers["x-attachment-name"],
        mimeType: request.headers["content-type"],
        contentLength: request.headers["x-attachment-size"] ?? request.headers["content-length"],
      })
      publish("attachment/uploaded", attachment)
      return sendJson(response, 201, attachment, cors)
    }
    if (request.method === "POST" && url.pathname === "/api/attachment-folders") {
      const input = await readJsonBody(request)
      const attachment = await attachmentStore.createFolder({ name: input.name })
      publish("attachment/folder-created", attachment)
      return sendJson(response, 201, attachment, cors)
    }
    if (request.method === "POST" && url.pathname === "/api/attachment-folders/select") {
      const selectedPath = await selectNativeFolder()
      if (selectedPath == null) return sendJson(response, 200, { cancelled: true }, cors)
      const attachment = await attachmentStore.importFolder(selectedPath)
      publish("attachment/folder-imported", attachment)
      return sendJson(response, 201, attachment, cors)
    }
    const folderFileMatch = url.pathname.match(/^\/api\/attachment-folders\/([^/]+)\/files$/)
    if (request.method === "POST" && folderFileMatch) {
      const attachment = await attachmentStore.uploadFolderFile(
        decodeURIComponent(folderFileMatch[1]),
        request,
        {
          relativePath: request.headers["x-attachment-relative-path"],
          contentLength: request.headers["x-attachment-size"] ?? request.headers["content-length"],
        }
      )
      publish("attachment/folder-file-uploaded", attachment)
      return sendJson(response, 201, attachment, cors)
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/attachments/")) {
      const attachmentId = decodeURIComponent(url.pathname.slice("/api/attachments/".length))
      const result = await commands.execute({
        command: "attachment.delete",
        input: { attachmentId },
      })
      return sendJson(response, 200, result.result, cors)
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })
      response.write(`event: snapshot\ndata: ${JSON.stringify(state.events)}\n\n`)
      const listener = (event) =>
        response.write(`event: mirror\ndata: ${JSON.stringify(event)}\n\n`)
      listeners.add(listener)
      request.on("close", () => listeners.delete(listener))
      return
    }
    if (request.method === "POST" && url.pathname === "/api/task") {
      const result = await commands.execute({
        command: "task.create",
        input: await readJsonBody(request),
      })
      return sendJson(response, 202, result.result, cors)
    }
    if (request.method === "POST" && url.pathname === "/api/follow-up") {
      const result = await commands.execute({
        command: "task.send",
        input: await readJsonBody(request),
      })
      return sendJson(response, 202, result.result, cors)
    }
    return sendJson(response, 404, { error: "not_found" }, cors)
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error)
    const status = /exceeds|limit/.test(state.lastError) ? 413 : 400
    sendJson(response, status, { error: state.lastError }, cors)
  }
})

async function shutdown() {
  await attachmentStore.cleanup().catch(() => {})
  if (launchdService) await unlink(paths.cdpWebDescriptor).catch(() => {})
  server.close()
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)

await attachmentStore.initialize()
await ensurePrivateDirectory(paths.root)
await ensureRuntimeReady()
server.listen(webPort, host, async () => {
  const health = await cdpHealth().catch(() => null)
  if (!health?.ready) {
    process.stderr.write(`CDP is not ready or not loopback-only on 127.0.0.1:${cdpPort}\n`)
  }
  const baseUrl = `http://${host}:${webPort}`
  const url = `${baseUrl}/#${token}`
  if (launchdService) {
    if (!launchId) throw new Error("--launch-id is required for a launchd service")
    await writeJsonAtomic(paths.cdpWebDescriptor, {
      launchId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      baseUrl,
      url,
      token,
      pairingCode,
      workspace,
      cdpPort,
    })
  }
  process.stdout.write(
    `Cognia normal-App control: ${url}\n` + `Cognia Web pairing code: ${pairingCode}\n`
  )
})
