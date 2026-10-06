/** Shared mode identifiers used by agent configuration and routing contracts. */
export type AgentModeType =
  | "general" // General purpose agent
  | "web-design" // Web page designer mode
  | "code-gen" // Code generation mode
  | "data-analysis" // Data analysis mode
  | "writing" // Writing assistant mode
  | "research" // Research assistant mode
  | "ppt-generation" // PPT/Presentation generation mode
  | "workflow" // Workflow execution mode
  | "academic" // Academic paper research mode
  | "plan" // Read-only planning mode (no edits)
  | "build" // Full-access build mode
  | "plugin" // Plugin-contributed mode
  | "custom" // Custom user-defined mode
