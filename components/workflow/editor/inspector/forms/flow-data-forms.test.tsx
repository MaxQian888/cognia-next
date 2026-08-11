import {
  BranchConfig,
  SetVariableConfig,
  WaitConfig,
  HttpRequestConfig,
  CodeConfig,
  TemplateConfig,
  TransformConfig,
  AggregateConfig,
  NoteConfig,
  GenericJsonConfig,
  SwitchConfig,
  SplitConfig,
  JoinConfig,
  LoopConfig,
  BreakConfig,
  ContinueConfig,
  SubworkflowConfig,
  WebhookRespondConfig,
  OutputConfig,
  GroupAnnotationConfig,
  CatchConfig,
} from "./flow-data-forms"

describe("flow-data-forms export surface", () => {
  it("exports its workflow inspector forms", () => {
    expect(
      [
        BranchConfig,
        SetVariableConfig,
        WaitConfig,
        HttpRequestConfig,
        CodeConfig,
        TemplateConfig,
        TransformConfig,
        AggregateConfig,
        NoteConfig,
        GenericJsonConfig,
        SwitchConfig,
        SplitConfig,
        JoinConfig,
        LoopConfig,
        BreakConfig,
        ContinueConfig,
        SubworkflowConfig,
        WebhookRespondConfig,
        OutputConfig,
        GroupAnnotationConfig,
        CatchConfig,
      ].every((form) => typeof form === "function")
    ).toBe(true)
  })
})
