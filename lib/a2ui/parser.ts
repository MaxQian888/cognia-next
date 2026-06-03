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

  switch (message.type) {
    case "createSurface":
      if (!message.surfaceId || typeof message.surfaceId !== "string") {
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
      if (!message.surfaceId || !Array.isArray(message.components)) {
        return null
      }
      return {
        type: "updateComponents",
        surfaceId: message.surfaceId as string,
        components: message.components as A2UIComponent[],
      }

    case "dataModelUpdate":
      if (!message.surfaceId || !message.data || typeof message.data !== "object") {
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
function parseSimplifiedA2UI(json: Record<string, unknown>): A2UIServerMessage[] | null {
  const surface = json.surface as Record<string, unknown> | undefined
  const components = json.components as A2UIComponent[] | undefined
  const dataModel = json.dataModel as Record<string, unknown> | undefined

  if (!components || !Array.isArray(components)) {
    return null
  }

  const surfaceId = (surface?.id as string) || `surface-${Date.now()}`
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

  return messages
}

function parseA2UIObject(input: unknown): A2UIParseResult {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const simplified = parseSimplifiedA2UI(input as Record<string, unknown>)
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

    const extracted = extractA2UIFromResponse(input)
    if (extracted?.messages.length) {
      return {
        surfaceId: resolveSurfaceId(extracted.messages, options.fallbackSurfaceId),
        messages: extracted.messages,
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

  const parsedObjectResult = parseA2UIObject(input)
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
      const mergedErrors: string[] = [...parsedObjectResult.errors]

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
  // Priority 1: Try to find A2UI-specific code blocks (```a2ui)
  const a2uiBlockRegex = /```a2ui\s*\n?([\s\S]*?)\n?```/gi
  let match = a2uiBlockRegex.exec(response)

  if (match) {
    const jsonContent = match[1].trim()
    const result = tryParseA2UIContent(jsonContent)
    if (result) return result
  }

  // Priority 2: Try to find JSON code blocks
  const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g

  while ((match = jsonBlockRegex.exec(response)) !== null) {
    const jsonContent = match[1].trim()
    if (detectA2UIContent(jsonContent)) {
      const result = tryParseA2UIContent(jsonContent)
      if (result) return result
    }
  }

  // Priority 3: Try parsing raw JSON if no code blocks found
  if (detectA2UIContent(response)) {
    const jsonContent = extractJsonFromText(response)
    if (jsonContent) {
      const result = tryParseA2UIContent(jsonContent)
      if (result) return result
    }
  }

  return null
}

/**
 * Try to parse A2UI content from JSON string
 */
function tryParseA2UIContent(jsonContent: string): A2UIMessageContent | null {
  try {
    const json = JSON.parse(jsonContent)

    // Try standard + simplified A2UI protocol format
    const parseResult = parseA2UIObject(json)
    if (parseResult.success && parseResult.messages.length > 0) {
      const surfaceId = resolveSurfaceId(parseResult.messages, "default") ?? "default"
      return {
        type: "a2ui",
        surfaceId,
        messages: parseResult.messages,
      }
    }
  } catch {
    // JSON parse failed, return null
  }
  return null
}

/**
 * Extract JSON object or array from text
 */
function extractJsonFromText(text: string): string | null {
  const jsonStart = text.indexOf("{")
  const jsonArrayStart = text.indexOf("[")
  const startIndex =
    jsonStart >= 0 && jsonArrayStart >= 0
      ? Math.min(jsonStart, jsonArrayStart)
      : Math.max(jsonStart, jsonArrayStart)

  if (startIndex < 0) return null

  // Find matching end bracket
  let depth = 0
  let endIndex = startIndex

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i]
    if (char === "{" || char === "[") depth++
    if (char === "}" || char === "]") depth--
    if (depth === 0) {
      endIndex = i
      break
    }
  }

  if (endIndex > startIndex) {
    return text.substring(startIndex, endIndex + 1)
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
