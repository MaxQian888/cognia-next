import { tool } from "ai"
import { z, type ZodType } from "zod"

export { tool }

export interface ToolConfig<TInput extends ZodType, TOutput> {
  description: string
  inputSchema: TInput
  execute: (input: z.infer<TInput>) => Promise<TOutput>
  strict?: boolean
  needsApproval?: boolean | ((input: z.infer<TInput>) => Promise<boolean>)
  inputExamples?: Array<{ input: z.infer<TInput> }>
}

export function createTool<TInput extends ZodType, TOutput>(
  definition: ToolConfig<TInput, TOutput>
) {
  const toolConfig: Record<string, unknown> = {
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: definition.execute,
  }

  if (definition.strict !== undefined) {
    toolConfig.strict = definition.strict
  }
  if (definition.needsApproval !== undefined) {
    toolConfig.needsApproval = definition.needsApproval
  }
  if (definition.inputExamples) {
    toolConfig.inputExamples = definition.inputExamples
  }

  return tool(toolConfig as never)
}

export function combineTools(
  ...toolObjects: Record<string, ReturnType<typeof tool>>[]
): Record<string, ReturnType<typeof tool>> {
  return Object.assign({}, ...toolObjects)
}
