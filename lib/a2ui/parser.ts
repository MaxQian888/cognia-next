/**
 * A2UI Message Parser
 * Parses A2UI JSON messages from AI responses and streaming content
 */

import type {
  A2UIServerMessage,
  A2UICreateSurfaceMessage,
  A2UIUpdateComponentsMessage,
  A2UIUpdateDataModelMessage,
  A2UIDeleteSurfaceMessage,
  A2UISurfaceReadyMessage,
  A2UIConnectorActionMessage,
  A2UIDispatchMessage,
  A2UIComponent,
  A2UIMessageContent,
  A2UIWidgetMetadata,
} from "@/types/a2ui/schema"
import { isA2UIDataModel, isSafeDataModelKey } from "./data-model"

/**
 * Result of parsing A2UI content
 */
export interface A2UIParseResult {
  success: boolean
  messages: A2UIServerMessage[]
  errors: string[]
}

/**
 * Unified parse result for mixed A2UI payloads.
 */
export interface A2UIUnifiedParseResult {
  surfaceId: string | null
  messages: A2UIServerMessage[]
  errors: string[]
}

export interface A2UIParseInputOptions {
  fallbackSurfaceId?: string
}

/**
 * A2UI message type guards
 */
export function isCreateSurfaceMessage(msg: A2UIServerMessage): msg is A2UICreateSurfaceMessage {
  return msg.type === "createSurface"
}

export function isUpdateComponentsMessage(
  msg: A2UIServerMessage
): msg is A2UIUpdateComponentsMessage {
  return msg.type === "updateComponents"
}

export function isUpdateDataModelMessage(
  msg: A2UIServerMessage
): msg is A2UIUpdateDataModelMessage {
  return msg.type === "dataModelUpdate"
}

export function isDeleteSurfaceMessage(msg: A2UIServerMessage): msg is A2UIDeleteSurfaceMessage {
  return msg.type === "deleteSurface"
}

export function isSurfaceReadyMessage(msg: A2UIServerMessage): msg is A2UISurfaceReadyMessage {
  return msg.type === "surfaceReady"
}

/**
 * Guard for the connector-action injection dispatched by the
 * `a2ui_handle_connector_action` MCP tool. Operates on the wider
 * `A2UIDispatchMessage` union since this message is not a server message.
 */
export function isConnectorActionMessage(
  msg: A2UIDispatchMessage
): msg is A2UIConnectorActionMessage {
  return msg.type === "connectorAction"
}

/**
 * Validate a single A2UI message
 */
function validateMessage(msg: unknown): A2UIServerMessage | null {
  if (!msg || typeof msg !== "object") {
    return null
  }

  const message = msg as Record<string, unknown>

  if (!message.type || typeof message.type !== "string") {
    return null
  }
  if (typeof message.surfaceId !== "string" || !isSafeDataModelKey(message.surfaceId)) return null

  switch (message.type) {
    case "createSurface":
      if (
        (message.surfaceType !== undefined &&
          !["inline", "dialog", "panel", "fullscreen"].includes(message.surfaceType as string)) ||
        (message.title !== undefined && typeof message.title !== "string") ||
        (message.catalogId !== undefined && typeof message.catalogId !== "string") ||
        (message.widget !== undefined &&
          (!message.widget || typeof message.widget !== "object" || Array.isArray(message.widget)))
      ) {
        return null
      }
      return {
        type: "createSurface",
        surfaceId: message.surfaceId,
        surfaceType:
          (message.surfaceType as "inline" | "dialog" | "panel" | "fullscreen") || "inline",
        catalogId: message.catalogId as string | undefined,
        title: message.title as string | undefined,
        widget: message.widget as A2UIWidgetMetadata | undefined,
      }

    case "updateComponents":
      if (
        !Array.isArray(message.components) ||
        !message.components.every(
          (component) =>
            component &&
            typeof component === "object" &&
            !Array.isArray(component) &&
            typeof component.id === "string" &&
            isSafeDataModelKey(component.id) &&
            typeof component.component === "string" &&
            component.component.length > 0
        )
      ) {
        return null
      }
      return {
        type: "updateComponents",
        surfaceId: message.surfaceId as string,
        components: message.components as A2UIComponent[],
      }

    case "dataModelUpdate":
      if (
        !isA2UIDataModel(message.data) ||
        (message.merge !== undefined && typeof message.merge !== "boolean")
      ) {
        return null
      }
      return {
        type: "dataModelUpdate",
        surfaceId: message.surfaceId as string,
        data: message.data as Record<string, unknown>,
        merge: message.merge as boolean | undefined,
      }

    case "deleteSurface":
      if (!message.surfaceId) {
        return null
      }
      return {
        type: "deleteSurface",
        surfaceId: message.surfaceId as string,
      }

    case "surfaceReady":
      if (!message.surfaceId) {
        return null
      }
      return {
        type: "surfaceReady",
        surfaceId: message.surfaceId as string,
      }

    default:
      return null
  }
}

/**
 * Parse a single JSON object as an A2UI message
 */
export function parseA2UIMessage(json: unknown): A2UIServerMessage | null {
  return validateMessage(json)
}

/**
 * Parse multiple A2UI messages from a JSON array
 */
export function parseA2UIMessages(json: unknown): A2UIParseResult {
  const result: A2UIParseResult = {
    success: false,
    messages: [],
    errors: [],
  }

  if (!json) {
    result.errors.push("Input is null or undefined")
    return result
  }

  // Handle single message object
  if (!Array.isArray(json)) {
    const msg = validateMessage(json)
    if (msg) {
      result.success = true
      result.messages.push(msg)
    } else {
      result.errors.push("Invalid A2UI message format")
    }
    return result
  }

  // Handle array of messages
  for (let i = 0; i < json.length; i++) {
    const msg = validateMessage(json[i])
    if (msg) {
      result.messages.push(msg)
    } else {
      result.errors.push(`Invalid message at index ${i}`)
    }
  }

  result.success = result.messages.length > 0
  return result
}

/**
 * Parse A2UI content from a JSON string
 */
export function parseA2UIString(jsonString: string): A2UIParseResult {
  try {
    const json = JSON.parse(jsonString)
    return parseA2UIMessages(json)
  } catch (error) {
    return {
      success: false,
      messages: [],
      errors: [`JSON parse error: ${error instanceof Error ? error.message : "Unknown error"}`],
    }
  }
}

/**
 * Parse JSONL (newline-delimited JSON) stream content
 * Each line is a separate A2UI message
 */
export function parseA2UIJsonl(content: string): A2UIParseResult {
  const result: A2UIParseResult = {
    success: false,
    messages: [],
    errors: [],
  }

  const lines = content.split("\n").filter((line) => line.trim())

  for (let i = 0; i < lines.length; i++) {
    try {
      const json = JSON.parse(lines[i])
      const msg = validateMessage(json)
      if (msg) {
        result.messages.push(msg)
      } else {
        result.errors.push(`Invalid message at line ${i + 1}`)
      }
    } catch (error) {
      result.errors.push(
        `JSON parse error at line ${i + 1}: ${error instanceof Error ? error.message : "Unknown"}`
      )
    }
  }

  result.success = result.messages.length > 0
  return result
}

/**
 * Detect if content contains A2UI messages
 * Supports multiple formats:
 * - Standard A2UI protocol messages (createSurface, updateComponents, etc.)
 * - Simplified A2UI format with "surface" and "components" keys
 * - A2UI code blocks with ```a2ui language identifier
 */
export function detectA2UIContent(content: string): boolean {
  // Check for A2UI code blocks first (most explicit)
  if (/```a2ui\s*\n/i.test(content)) {
    return true
  }

  // Quick heuristic checks before attempting parse
  if (!content.includes('"')) {
    return false
  }

  // Check for standard A2UI protocol messages
  const a2uiTypes = [
    "createSurface",
    "updateComponents",
    "dataModelUpdate",
    "deleteSurface",
    "surfaceReady",
  ]
  for (const type of a2uiTypes) {
    if (content.includes(`"${type}"`)) {
      return true
    }
  }

  // Check for simplified A2UI format (surface + components)
  if (content.includes('"surface"') && content.includes('"components"')) {
    return true
  }

  // Check for component-only format (just components array with A2UI component types)
  const componentTypes = [
    "Button",
    "TextField",
    "Select",
    "Slider",
    "Card",
    "Row",
    "Column",
    "Chart",
    "Table",
  ]
  if (content.includes('"component"')) {
    for (const type of componentTypes) {
      if (content.includes(`"${type}"`)) {
        return true
      }
    }
  }

  return false
}

/**
 * Parse simplified A2UI format into standard messages
 * Simplified format: { surface: {...}, components: [...], dataModel?: {...} }
 */
function parseSimplifiedA2UI(
  json: Record<string, unknown>,
  options: A2UIParseInputOptions
): A2UIServerMessage[] | null {
  const surface = json.surface as Record<string, unknown> | undefined
  const components = json.components as A2UIComponent[] | undefined
  const dataModel = json.dataModel as Record<string, unknown> | undefined

  if (surface !== undefined && (!surface || typeof surface !== "object" || Array.isArray(surface)))
    return null
  if (
    surface?.id !== undefined &&
    (typeof surface.id !== "string" || !isSafeDataModelKey(surface.id))
  )
    return null
  if (json.dataModel !== undefined && !isA2UIDataModel(json.dataModel)) return null

  if (!components || !Array.isArray(components)) {
    return null
  }

  const surfaceId =
    (surface?.id as string) || options.fallbackSurfaceId || `surface-${crypto.randomUUID()}`
  const surfaceType = (surface?.type as "inline" | "dialog" | "panel" | "fullscreen") || "inline"
  const title = surface?.title as string | undefined
  const widget = surface?.widget as A2UIWidgetMetadata | undefined

  const messages: A2UIServerMessage[] = [
    {
      type: "createSurface",
      surfaceId,
      surfaceType,
      title,
      widget,
    },
    {
      type: "updateComponents",
      surfaceId,
      components,
    },
  ]

  if (dataModel && Object.keys(dataModel).length > 0) {
    messages.push({
      type: "dataModelUpdate",
      surfaceId,
      data: dataModel,
    })
  }

  messages.push({
    type: "surfaceReady",
    surfaceId,
  })

  return messages.every((message) => validateMessage(message) !== null) ? messages : null
}

function parseA2UIObject(input: unknown, options: A2UIParseInputOptions = {}): A2UIParseResult {
  if (input && typeof input === "object" && !Array.isArray(input) && !("type" in input)) {
    const simplified = parseSimplifiedA2UI(input as Record<string, unknown>, options)
    if (simplified && simplified.length > 0) {
      return {
        success: true,
        messages: simplified,
        errors: [],
      }
    }
  }

  return parseA2UIMessages(input)
}

function resolveSurfaceId(
  messages: A2UIServerMessage[],
  fallbackSurfaceId?: string
): string | null {
  const firstMessageWithSurface = messages.find(
    (message): message is A2UIServerMessage & { surfaceId: string } =>
      "surfaceId" in message && typeof message.surfaceId === "string"
  )
  return firstMessageWithSurface?.surfaceId ?? fallbackSurfaceId ?? null
}

function collectA2UITextPayloads(payload: Record<string, unknown>): string[] {
  const texts: string[] = []

  if (typeof payload.text === "string") {
    texts.push(payload.text)
  }

  if (typeof payload.result === "string") {
    texts.push(payload.result)
  }

  const content = payload.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") {
        continue
      }

      const contentItem = item as Record<string, unknown>
      if (contentItem.type === "text" && typeof contentItem.text === "string") {
        texts.push(contentItem.text)
      }

      if (contentItem.type === "resource") {
        const resource = contentItem.resource
        if (resource && typeof resource === "object") {
          const resourceText = (resource as Record<string, unknown>).text
          if (typeof resourceText === "string") {
            texts.push(resourceText)
          }
        }
      }
    }
  }

  return texts
}

/**
 * Unified parser for mixed A2UI payload inputs (string/object/array/code block/tool result).
 */
export function parseA2UIInput(
  input: unknown,
  options: A2UIParseInputOptions = {}
): A2UIUnifiedParseResult {
  const emptyResult: A2UIUnifiedParseResult = {
    surfaceId: options.fallbackSurfaceId ?? null,
    messages: [],
    errors: [],
  }

  if (input === null || input === undefined) {
    return emptyResult
  }

  if (typeof input === "string") {
    const trimmed = input.trim()
    if (!trimmed) {
      return emptyResult
    }

    const blocks = extractA2UIBlocks(input, options)
    if (blocks.length) {
      const messages = blocks.flatMap((block) => block.content.messages)
      return {
        surfaceId: resolveSurfaceId(messages, options.fallbackSurfaceId),
        messages,
        errors: [],
      }
    }

    const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[")
    if (!looksLikeJson && !detectA2UIContent(input)) {
      return emptyResult
    }

    try {
      const parsed = JSON.parse(trimmed)
      return parseA2UIInput(parsed, options)
    } catch (error) {
      return {
        ...emptyResult,
        errors: [`JSON parse error: ${error instanceof Error ? error.message : "Unknown error"}`],
      }
    }
  }

  const parsedObjectResult = parseA2UIObject(input, options)
  if (parsedObjectResult.success && parsedObjectResult.messages.length > 0) {
    return {
      surfaceId: resolveSurfaceId(parsedObjectResult.messages, options.fallbackSurfaceId),
      messages: parsedObjectResult.messages,
      errors: parsedObjectResult.errors,
    }
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const payload = input as Record<string, unknown>
    const nestedMessages = payload.messages
    if (nestedMessages !== undefined) {
      const nestedResult = parseA2UIInput(nestedMessages, options)
      if (nestedResult.messages.length > 0) {
        return nestedResult
      }
      parsedObjectResult.errors.push(...nestedResult.errors)
    }

    const textPayloads = collectA2UITextPayloads(payload)
    if (textPayloads.length > 0) {
      const mergedMessages: A2UIServerMessage[] = []
      const mergedErrors: string[] = []

      for (const textPayload of textPayloads) {
        const nestedResult = parseA2UIInput(textPayload, options)
        if (nestedResult.messages.length > 0) {
          mergedMessages.push(...nestedResult.messages)
        } else if (nestedResult.errors.length > 0) {
          mergedErrors.push(...nestedResult.errors)
        }
      }

      if (mergedMessages.length > 0) {
        return {
          surfaceId: resolveSurfaceId(mergedMessages, options.fallbackSurfaceId),
          messages: mergedMessages,
          errors: mergedErrors,
        }
      }

      return {
        ...emptyResult,
        errors: mergedErrors,
      }
    }
  }

  return {
    ...emptyResult,
    errors: parsedObjectResult.errors,
  }
}

/**
 * Extract A2UI content from mixed AI response
 * Looks for JSON blocks that contain A2UI messages
 * Supports multiple formats:
 * - ```a2ui code blocks (preferred)
 * - ```json code blocks with A2UI content
 * - Simplified format: { surface: {...}, components: [...] }
 * - Standard A2UI protocol messages
 */
export function extractA2UIFromResponse(response: string): A2UIMessageContent | null {
  return extractA2UIBlocks(response)[0]?.content ?? null
}

export interface A2UIExtractedBlock {
  /** Exact source span, including code fences when present. */
  start: number
  end: number
  content: A2UIMessageContent
}

/** Extract every valid payload without treating examples in other languages as UI. */
export function extractA2UIBlocks(
  response: string,
  options: A2UIParseInputOptions = {}
): A2UIExtractedBlock[] {
  const blocks: A2UIExtractedBlock[] = []
  const append = (start: number, end: number, payload: string) => {
    const content = tryParseA2UIContent(payload, {
      ...options,
      fallbackSurfaceId:
        options.fallbackSurfaceId && blocks.length > 0
          ? `${options.fallbackSurfaceId}:${blocks.length}`
          : options.fallbackSurfaceId,
    })
    if (content) blocks.push({ start, end, content })
  }
  const scanRaw = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (response[index] !== "{" && response[index] !== "[") continue
      const jsonEnd = findJsonEnd(response, index, end)
      if (jsonEnd === null) continue
      append(index, jsonEnd, response.slice(index, jsonEnd))
      index = jsonEnd - 1
    }
  }

  const opening = /(`{3,}|~{3,})([^\r\n]*)\r?\n/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(response)) !== null) {
    scanRaw(cursor, match.index)
    const marker = match[1][0]
    const closing = new RegExp(`^[ \t]{0,3}${marker}{${match[1].length},}[ \t]*(?=\r?$)`, "gm")
    closing.lastIndex = opening.lastIndex
    const close = closing.exec(response)
    // An unfinished fence is streaming content, never a raw-JSON candidate.
    if (!close) return blocks
    const end = close.index + close[0].length
    if (/^(?:a2ui|json|jsonl)?$/i.test(match[2].trim())) {
      append(match.index, end, response.slice(opening.lastIndex, close.index))
    }
    cursor = end
    opening.lastIndex = end
  }
  scanRaw(cursor, response.length)
  return blocks
}

/** JSONL is accepted only when every nonblank line is a valid protocol event. */
function tryParseA2UIContent(
  jsonContent: string,
  options: A2UIParseInputOptions
): A2UIMessageContent | null {
  let result: A2UIParseResult
  try {
    result = parseA2UIObject(JSON.parse(jsonContent), options)
  } catch {
    result = parseA2UIJsonl(jsonContent)
  }
  if (!result.success || result.errors.length) return null
  return {
    type: "a2ui",
    surfaceId: resolveSurfaceId(result.messages, options.fallbackSurfaceId) ?? "default",
    messages: result.messages,
  }
}

/** Scan structural brackets while ignoring escaped quotes and brackets in strings. */
function findJsonEnd(text: string, start: number, limit: number): number | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = start; index < limit; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") stack.push(char)
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) return null
      if (stack.length === 0) return index + 1
    }
  }
  return null
}

/**
 * Create a minimal A2UI surface from components
 * Utility for programmatic A2UI generation
 */
export function createA2UISurface(
  surfaceId: string,
  components: A2UIComponent[],
  dataModel?: Record<string, unknown>,
  options?: {
    surfaceType?: "inline" | "dialog" | "panel" | "fullscreen"
    title?: string
    widget?: A2UIWidgetMetadata
  }
): A2UIServerMessage[] {
  const messages: A2UIServerMessage[] = [
    {
      type: "createSurface",
      surfaceId,
      surfaceType: options?.surfaceType || "inline",
      title: options?.title,
      widget: options?.widget,
    },
    {
      type: "updateComponents",
      surfaceId,
      components,
    },
  ]

  if (dataModel && Object.keys(dataModel).length > 0) {
    messages.push({
      type: "dataModelUpdate",
      surfaceId,
      data: dataModel,
    })
  }

  messages.push({
    type: "surfaceReady",
    surfaceId,
  })

  return messages
}
