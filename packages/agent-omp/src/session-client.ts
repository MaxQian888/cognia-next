import type * as Wire from "./wire"
import type { OmpPromptTicket } from "./rpc-peer"

export type OmpRequestDispatch = <K extends Wire.OmpCommandName>(
  type: K,
  ...args: undefined extends Wire.OmpCommandMap[K]["params"]
    ? [params?: Wire.OmpCommandMap[K]["params"]]
    : [params: Wire.OmpCommandMap[K]["params"]]
) => Promise<Wire.OmpCommandMap[K]["result"]>

export interface OmpSessionClientPorts {
  /** The adapter owns gates, command permissions, and session-transition policy. */
  request: OmpRequestDispatch
  prompt: (
    params: Wire.PromptParams | Wire.AbortAndPromptParams,
    type: "prompt" | "abort_and_prompt"
  ) => OmpPromptTicket
}

/** Complete named OMP v18.6.1 command surface over host-owned dispatch. */
export class OmpSessionClient {
  constructor(private readonly ports: OmpSessionClientPorts) {}

  negotiateProtocol(params: Wire.NegotiateProtocolParams): Promise<Wire.NegotiateProtocolResult> {
    return this.ports.request("negotiate_protocol", params)
  }

  prompt(params: Wire.PromptParams): OmpPromptTicket {
    return this.ports.prompt(params, "prompt")
  }

  steer(params: Wire.SteerParams): Promise<undefined> {
    return this.ports.request("steer", params)
  }

  followUp(params: Wire.FollowUpParams): Promise<undefined> {
    return this.ports.request("follow_up", params)
  }

  removeQueuedMessage(
    params: Wire.RemoveQueuedMessageParams
  ): Promise<Wire.RemoveQueuedMessageResult> {
    return this.ports.request("remove_queued_message", params)
  }

  promoteQueuedMessage(
    params: Wire.PromoteQueuedMessageParams
  ): Promise<Wire.PromoteQueuedMessageResult> {
    return this.ports.request("promote_queued_message", params)
  }

  abort(): Promise<undefined> {
    return this.ports.request("abort")
  }

  abortAndPrompt(params: Wire.AbortAndPromptParams): OmpPromptTicket {
    return this.ports.prompt(params, "abort_and_prompt")
  }

  newSession(params: Wire.NewSessionParams = {}): Promise<Wire.CancellationResult> {
    return this.ports.request("new_session", params)
  }

  openSession(params: Wire.OpenSessionParams): Promise<Wire.OpenSessionResult> {
    return this.ports.request("open_session", params)
  }

  getState(): Promise<Wire.SessionState> {
    return this.ports.request("get_state")
  }

  setFastMode(params: Wire.SetFastModeParams): Promise<Wire.FastModeResult> {
    return this.ports.request("set_fast_mode", params)
  }

  goal(params: Wire.GoalParams): Promise<Wire.GoalResult> {
    return this.ports.request("goal", params)
  }

  setAskDialog(params: Wire.SetAskDialogParams): Promise<Wire.SetAskDialogResult> {
    return this.ports.request("set_ask_dialog", params)
  }

  getAvailableCommands(): Promise<Wire.GetAvailableCommandsResult> {
    return this.ports.request("get_available_commands")
  }

  getEntries(params: Wire.GetEntriesParams = {}): Promise<Wire.SessionEntries> {
    return this.ports.request("get_entries", params)
  }

  getTree(): Promise<Wire.SessionTree> {
    return this.ports.request("get_tree")
  }

  setTodos(params: Wire.SetTodosParams): Promise<Wire.SetTodosResult> {
    return this.ports.request("set_todos", params)
  }

  setHostTools(params: Wire.SetHostToolsParams): Promise<Wire.SetHostToolsResult> {
    return this.ports.request("set_host_tools", params)
  }

  setHostUriSchemes(params: Wire.SetHostUriSchemesParams): Promise<Wire.SetHostUriSchemesResult> {
    return this.ports.request("set_host_uri_schemes", params)
  }

  setSubagentSubscription(
    params: Wire.SetSubagentSubscriptionParams
  ): Promise<Wire.SetSubagentSubscriptionResult> {
    return this.ports.request("set_subagent_subscription", params)
  }

  setEventFilter(params: Wire.SetEventFilterParams): Promise<Wire.SetEventFilterResult> {
    return this.ports.request("set_event_filter", params)
  }

  getSubagents(): Promise<Wire.GetSubagentsResult> {
    return this.ports.request("get_subagents")
  }

  getSubagentMessages(params: Wire.GetSubagentMessagesParams = {}): Promise<Wire.SubagentMessages> {
    return this.ports.request("get_subagent_messages", params)
  }

  cancelSubagent(params: Wire.CancelSubagentParams): Promise<Wire.CancelSubagentResult> {
    return this.ports.request("cancel_subagent", params)
  }

  steerSubagent(params: Wire.SteerSubagentParams): Promise<undefined> {
    return this.ports.request("steer_subagent", params)
  }

  liveStart(params: Wire.LiveStartParams = {}): Promise<Wire.LiveStartResult> {
    return this.ports.request("live_start", params)
  }

  liveStop(): Promise<undefined> {
    return this.ports.request("live_stop")
  }

  liveMute(params: Wire.LiveMuteParams = {}): Promise<Wire.LiveMuteResult> {
    return this.ports.request("live_mute", params)
  }

  setModel(params: Wire.SetModelParams): Promise<Wire.ModelInfo> {
    return this.ports.request("set_model", params)
  }

  cycleModel(): Promise<Wire.ModelCycleResult | null> {
    return this.ports.request("cycle_model")
  }

  getAvailableModels(): Promise<Wire.GetAvailableModelsResult> {
    return this.ports.request("get_available_models")
  }

  setThinkingLevel(params: Wire.SetThinkingLevelParams): Promise<undefined> {
    return this.ports.request("set_thinking_level", params)
  }

  cycleThinkingLevel(): Promise<Wire.ThinkingLevelCycleResult | null> {
    return this.ports.request("cycle_thinking_level")
  }

  getAvailableThinkingLevels(): Promise<Wire.GetAvailableThinkingLevelsResult> {
    return this.ports.request("get_available_thinking_levels")
  }

  setSteeringMode(params: Wire.SetSteeringModeParams): Promise<undefined> {
    return this.ports.request("set_steering_mode", params)
  }

  setFollowUpMode(params: Wire.SetFollowUpModeParams): Promise<undefined> {
    return this.ports.request("set_follow_up_mode", params)
  }

  setInterruptMode(params: Wire.SetInterruptModeParams): Promise<undefined> {
    return this.ports.request("set_interrupt_mode", params)
  }

  compact(params: Wire.CompactParams = {}): Promise<Wire.CompactionResult> {
    return this.ports.request("compact", params)
  }

  setAutoCompaction(params: Wire.SetAutoCompactionParams): Promise<undefined> {
    return this.ports.request("set_auto_compaction", params)
  }

  setCacheWarming(params: Wire.SetCacheWarmingParams): Promise<Wire.SetCacheWarmingResult> {
    return this.ports.request("set_cache_warming", params)
  }

  setAutoRetry(params: Wire.SetAutoRetryParams): Promise<undefined> {
    return this.ports.request("set_auto_retry", params)
  }

  abortRetry(): Promise<undefined> {
    return this.ports.request("abort_retry")
  }

  bash(params: Wire.BashParams): Promise<Wire.BashResult> {
    return this.ports.request("bash", params)
  }

  abortBash(): Promise<undefined> {
    return this.ports.request("abort_bash")
  }

  getSessionStats(): Promise<Wire.SessionStats> {
    return this.ports.request("get_session_stats")
  }

  exportHtml(params: Wire.ExportHtmlParams = {}): Promise<Wire.ExportHtmlResult> {
    return this.ports.request("export_html", params)
  }

  switchSession(params: Wire.SwitchSessionParams): Promise<Wire.CancellationResult> {
    return this.ports.request("switch_session", params)
  }

  branch(params: Wire.BranchParams): Promise<Wire.BranchResult> {
    return this.ports.request("branch", params)
  }

  fork(params: Wire.ForkParams = {}): Promise<Wire.CancellationResult> {
    return this.ports.request("fork", params)
  }

  getBranchMessages(): Promise<Wire.GetBranchMessagesResult> {
    return this.ports.request("get_branch_messages")
  }

  getLastAssistantText(): Promise<Wire.GetLastAssistantTextResult> {
    return this.ports.request("get_last_assistant_text")
  }

  setSessionName(params: Wire.SetSessionNameParams): Promise<undefined> {
    return this.ports.request("set_session_name", params)
  }

  handoff(params: Wire.HandoffParams = {}): Promise<Wire.HandoffResult | null> {
    return this.ports.request("handoff", params)
  }

  getMessages(): Promise<Wire.GetMessagesResult> {
    return this.ports.request("get_messages")
  }

  getMessagesPage(params: Wire.GetMessagesPageParams = {}): Promise<Wire.MessagesPage> {
    return this.ports.request("get_messages_page", params)
  }

  getLoginProviders(): Promise<Wire.GetLoginProvidersResult> {
    return this.ports.request("get_login_providers")
  }

  login(params: Wire.LoginParams): Promise<Wire.LoginResult> {
    return this.ports.request("login", params)
  }

  predictWord(params: Wire.PredictWordParams): Promise<Wire.PredictWordResult> {
    return this.ports.request("predict_word", params)
  }

  predictWordFeedback(params: Wire.PredictWordFeedbackParams): Promise<undefined> {
    return this.ports.request("predict_word_feedback", params)
  }
}
