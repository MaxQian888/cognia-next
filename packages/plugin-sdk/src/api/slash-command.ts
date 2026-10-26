/** Portable command contracts. Runtime dispatch is owned by manifest commands and hooks. */

export { defineCommand } from "../define/define-command"

export type {
  RegisterSlashCommandResult,
  SlashCommandContext,
  SlashCommandDefinition,
  SlashCommandHandler,
  SlashCommandResult,
} from "@cognia/plugin-contract/lib/slash-commands/registry"
