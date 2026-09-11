//! OpenAI **Responses API** ⇄ canonical IR translation.
//!
//! The Responses API (`POST /v1/responses`) is a different request/response
//! shape from Chat Completions, but its core is the same single-turn chat the
//! gateway already routes. We parse a Responses request INTO [`ChatIR`] (so it
//! reuses `request_from_ir` for every upstream protocol — openai AND anthropic
//! providers work) and render the upstream [`IrResponse`] back OUT into a
//! Responses object.
//!
//! Message/function/custom-tool turns translate through the existing chat executor.
//! Streaming is incremental; continuation history is scoped by the server to its caller.

use serde_json::{json, Value};

use super::errors::NotTranslatable;
use super::ir::{
    ChatIR, IrContent, IrImage, IrMessage, IrResponse, IrRole, IrStopReason, IrToolChoice,
    IrToolDef,
};

/// Features requiring native upstream execution, not lossless chat translation.
pub fn unsupported_feature(body: &Value) -> Option<String> {
    if body["background"].as_bool() == Some(true) {
        return Some("background execution requires a native Responses upstream".into());
    }
    None
}

/// Parse an OpenAI Responses request body into the canonical [`ChatIR`].
pub fn request_to_ir(body: &Value) -> Result<ChatIR, NotTranslatable> {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .ok_or_else(|| NotTranslatable::new("model is required".to_string()))?
        .to_string();

    // `instructions` is the system prompt. System/developer input items append.
    let mut system_parts: Vec<String> = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        if !instructions.trim().is_empty() {
            system_parts.push(instructions.to_string());
        }
    }

    let mut messages: Vec<IrMessage> = Vec::new();
    match body.get("input") {
        Some(Value::String(text)) => {
            messages.push(IrMessage {
                role: IrRole::User,
                content: vec![IrContent::Text(text.clone())],
            });
        }
        Some(Value::Array(items)) => {
            for item in items {
                let item_type = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message");
                if matches!(item_type, "function_call" | "custom_tool_call") {
                    let id = required_string(item, "call_id")?;
                    let name = qualified_name(item)?;
                    let input = if item_type == "custom_tool_call" {
                        json!({"input": required_string(item, "input")?})
                    } else {
                        serde_json::from_str(&required_string(item, "arguments")?).map_err(
                            |_| NotTranslatable::new("function_call arguments must be JSON"),
                        )?
                    };
                    messages.push(IrMessage {
                        role: IrRole::Assistant,
                        content: vec![IrContent::ToolUse { id, name, input }],
                    });
                    continue;
                }
                if matches!(
                    item_type,
                    "function_call_output" | "custom_tool_call_output"
                ) {
                    let tool_use_id = required_string(item, "call_id")?;
                    let output = item
                        .get("output")
                        .ok_or_else(|| NotTranslatable::new("tool output is required"))?;
                    let parts = parse_content(Some(output))?;
                    messages.push(IrMessage {
                        role: IrRole::User,
                        content: vec![super::ir::tool_result(tool_use_id, parts, false)],
                    });
                    continue;
                }
                if item_type == "reasoning" {
                    // Our translated reasoning summaries are advisory, not encrypted provider state.
                    if item.get("encrypted_content").is_some_and(|v| !v.is_null()) {
                        return Err(NotTranslatable::new(
                            "encrypted reasoning requires its original native Responses upstream",
                        ));
                    }
                    continue;
                }
                if item_type != "message" {
                    return Err(NotTranslatable::new(format!(
                        "input item type \"{item_type}\" is not supported on /v1/responses"
                    )));
                }
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = parse_content(item.get("content"))?;
                match role {
                    "system" | "developer" => {
                        for part in &content {
                            if let IrContent::Text(text) = part {
                                system_parts.push(text.clone());
                            } else {
                                return Err(NotTranslatable::new("system/developer images have no supported cross-protocol representation"));
                            }
                        }
                    }
                    "assistant" => messages.push(IrMessage {
                        role: IrRole::Assistant,
                        content,
                    }),
                    _ => messages.push(IrMessage {
                        role: IrRole::User,
                        content,
                    }),
                }
            }
        }
        _ => {
            return Err(NotTranslatable::new(
                "input is required (a string or an array of message items)".to_string(),
            ))
        }
    }

    if messages.is_empty() {
        return Err(NotTranslatable::new(
            "input produced no user/assistant messages".to_string(),
        ));
    }

    let mut ir = ChatIR {
        losses: Vec::new(),
        model,
        system: if system_parts.is_empty() {
            None
        } else {
            Some(system_parts.join("\n\n"))
        },
        messages,
        tools: parse_tools(body)?,
        parallel_tool_calls: super::ir::optional_bool(
            body.get("parallel_tool_calls"),
            "parallel_tool_calls",
        )?,
        response_format: super::ir::output_format(body["text"].get("format"), "responses")?,
        reasoning_effort: body["reasoning"]
            .get("effort")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| NotTranslatable::new("reasoning.effort must be a string"))
            })
            .transpose()?,
        thinking: None,
        tool_choice: match body.get("tool_choice") {
            Some(Value::String(s)) => Some(match s.as_str() {
                "auto" => IrToolChoice::Auto,
                "required" => IrToolChoice::Any,
                "none" => IrToolChoice::None,
                _ => return Err(NotTranslatable::new("unknown tool_choice")),
            }),
            Some(Value::Object(_)) => Some(IrToolChoice::Tool(required_string(
                &body["tool_choice"],
                "name",
            )?)),
            _ => None,
        },
        max_tokens: body.get("max_output_tokens").and_then(Value::as_u64),
        temperature: body.get("temperature").and_then(Value::as_f64),
        top_p: body.get("top_p").and_then(Value::as_f64),
        stop: Vec::new(),
        stream: body["stream"].as_bool().unwrap_or(false),
    };
    if body["reasoning"]
        .get("summary")
        .is_some_and(|v| !v.is_null())
    {
        ir.losses.push(super::ir::TranslationLoss::approximated("reasoning.summary",
            "translated reasoning summaries follow the upstream stream; its summary verbosity control has no cross-protocol equivalent"));
    }
    for tool in flattened_tools(body)? {
        if tool["type"] == "custom" && tool["format"]["type"] == "grammar" {
            ir.losses.push(super::ir::TranslationLoss::approximated("tools[].format",
                "custom-tool grammar is supplied as a descriptive constraint; only a native Responses upstream enforces its grammar"));
        }
    }
    ir.validate_tool_choice()?;
    Ok(ir)
}

fn required_string(value: &Value, field: &str) -> Result<String, NotTranslatable> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| NotTranslatable::new(format!("{field} is required")))
}

fn qualified_name(item: &Value) -> Result<String, NotTranslatable> {
    let name = required_string(item, "name")?;
    if let Some(namespace) = item["namespace"].as_str() {
        // Stable bounded wire name; namespace remains explicit on client output.
        let identity = format!("{namespace}/{name}");
        let hash = identity.bytes().fold(0xcbf29ce484222325u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        });
        Ok(format!("cognia_ns_{hash:016x}"))
    } else {
        Ok(name)
    }
}

fn flattened_tools(body: &Value) -> Result<Vec<Value>, NotTranslatable> {
    let mut out = Vec::new();
    let Some(tools) = body.get("tools").filter(|v| !v.is_null()) else {
        return Ok(out);
    };
    for tool in tools
        .as_array()
        .ok_or_else(|| NotTranslatable::new("tools must be an array"))?
    {
        if tool["type"] == "namespace" {
            let namespace = required_string(tool, "name")?;
            for child in tool["tools"]
                .as_array()
                .ok_or_else(|| NotTranslatable::new("namespace tools must be an array"))?
            {
                let mut child = child.clone();
                child["namespace"] = json!(namespace);
                out.push(child);
            }
        } else {
            out.push(tool.clone());
        }
    }
    Ok(out)
}

pub fn tool_namespaces(body: &Value) -> std::collections::BTreeMap<String, (String, String)> {
    flattened_tools(body)
        .unwrap_or_default()
        .iter()
        .filter_map(|tool| {
            Some((
                qualified_name(tool).ok()?,
                (
                    tool["namespace"].as_str()?.into(),
                    tool["name"].as_str()?.into(),
                ),
            ))
        })
        .collect()
}

fn restore_item_namespace(
    item: &mut Value,
    namespaces: &std::collections::BTreeMap<String, (String, String)>,
) {
    if let Some((namespace, name)) = item["name"].as_str().and_then(|name| namespaces.get(name)) {
        item["namespace"] = json!(namespace);
        item["name"] = json!(name);
    }
}
pub fn restore_namespaces(
    response: &mut Value,
    namespaces: &std::collections::BTreeMap<String, (String, String)>,
) {
    for item in response["output"].as_array_mut().into_iter().flatten() {
        restore_item_namespace(item, namespaces);
    }
}

fn parse_tools(body: &Value) -> Result<Vec<IrToolDef>, NotTranslatable> {
    let mut tools = Vec::new();
    for item in flattened_tools(body)? {
        let name = qualified_name(&item)?;
        let mut description = item["description"].as_str().map(str::to_owned);
        if let Some(namespace) = item["namespace"].as_str() {
            description = Some(format!(
                "Tool {}.{}. {}",
                namespace,
                item["name"].as_str().unwrap_or(""),
                description.unwrap_or_default()
            ));
        }
        let schema = match item["type"].as_str() {
            Some("function") => item
                .get("parameters")
                .cloned()
                .unwrap_or(json!({"type":"object","properties":{}})),
            Some("custom") => {
                if let Some(format) = item.get("format") {
                    description = Some(format!(
                        "{}\nInput format: {}",
                        description.unwrap_or_default(),
                        format
                    ));
                }
                json!({"type":"object","properties":{"input":{"type":"string"}},"required":["input"],"additionalProperties":false})
            }
            _ => {
                return Err(NotTranslatable::new(format!(
                    "tool type {} requires a native Responses upstream",
                    item["type"]
                )))
            }
        };
        tools.push(IrToolDef {
            name,
            description,
            input_schema: schema,
            strict: super::ir::optional_bool(item.get("strict"), "tools[].strict")?,
        });
    }
    Ok(tools)
}

pub fn custom_tool_names(body: &Value) -> Vec<String> {
    flattened_tools(body)
        .unwrap_or_default()
        .iter()
        .filter(|t| t["type"] == "custom")
        .filter_map(|t| qualified_name(t).ok())
        .collect()
}

pub fn to_chat(body: &Value) -> Result<Value, NotTranslatable> {
    let ir = request_to_ir(body)?;
    super::request_from_ir("openai", &ir)
}

/// Render the common IR to a native Responses request for Responses-only deployments.
pub fn request_from_ir(ir: &ChatIR) -> Value {
    let mut input = Vec::new();
    for message in &ir.messages {
        let mut parts = Vec::new();
        for part in &message.content {
            match part {
                IrContent::Text(text) => parts.push(json!({"type":if message.role == IrRole::Assistant {"output_text"} else {"input_text"},"text":text})),
                IrContent::Image(image) => {
                    let url = match image { IrImage::Url(url) => url.clone(), IrImage::Base64{media_type,data} => format!("data:{media_type};base64,{data}") };
                    parts.push(json!({"type":"input_image","image_url":url}));
                }
                IrContent::ToolUse{id,name,input:args} => input.push(json!({"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()})),
                IrContent::ToolResultMedia{tool_use_id,content,..} => input.push(json!({"type":"function_call_output","call_id":tool_use_id,
                    "output":content.iter().map(|part|match part {
                        IrContent::Text(text)=>json!({"type":"input_text","text":text}),
                        IrContent::Image(image)=>{let url=match image {IrImage::Url(url)=>url.clone(),IrImage::Base64{media_type,data}=>format!("data:{media_type};base64,{data}")};json!({"type":"input_image","image_url":url})},
                        _ => unreachable!("tool result parts are text/images"),
                    }).collect::<Vec<_>>()})),
                IrContent::ToolResult{tool_use_id,content,..} => input.push(json!({"type":"function_call_output","call_id":tool_use_id,"output":content})),
            }
        }
        if !parts.is_empty() {
            input.push(json!({"type":"message","role":if message.role == IrRole::Assistant {"assistant"} else {"user"},"content":parts}));
        }
    }
    let mut body = json!({"model":ir.model,"input":input,"stream":ir.stream});
    if let Some(system) = &ir.system {
        body["instructions"] = json!(system);
    }
    if let Some(max) = ir.max_tokens {
        body["max_output_tokens"] = json!(max);
    }
    if let Some(temp) = ir.temperature {
        body["temperature"] = json!(temp);
    }
    if let Some(top_p) = ir.top_p {
        body["top_p"] = json!(top_p);
    }
    if !ir.tools.is_empty() {
        body["tools"] = json!(ir.tools.iter().map(|t| {
            let mut tool = json!({"type":"function","name":t.name,"description":t.description,"parameters":t.input_schema});
            if let Some(strict) = t.strict { tool["strict"] = json!(strict); }
            tool
        }).collect::<Vec<_>>());
    }
    if let Some(parallel) = ir.parallel_tool_calls {
        body["parallel_tool_calls"] = json!(parallel);
    }
    if let Some(effort) = &ir.reasoning_effort {
        body["reasoning"] = json!({"effort":effort});
    }
    if let Some(format) = &ir.response_format {
        let wire = if format["type"] == "json_schema" {
            let mut wire = format["json_schema"].clone();
            wire["type"] = json!("json_schema");
            wire
        } else {
            format.clone()
        };
        body["text"] = json!({"format":wire});
    }
    if let Some(choice) = &ir.tool_choice {
        body["tool_choice"] = match choice {
            IrToolChoice::Auto => json!("auto"),
            IrToolChoice::Any => json!("required"),
            IrToolChoice::None => json!("none"),
            IrToolChoice::Tool(name) => json!({"type":"function","name":name}),
        };
    }
    body
}

pub fn response_to_ir(body: &Value) -> Result<IrResponse, NotTranslatable> {
    let mut content = Vec::new();
    for item in body["output"]
        .as_array()
        .ok_or_else(|| NotTranslatable::new("Responses output is missing"))?
    {
        match item["type"].as_str() {
            Some("message") => content.extend(parse_content(item.get("content"))?),
            Some("function_call") => content.push(IrContent::ToolUse {
                id: required_string(item, "call_id")?,
                name: required_string(item, "name")?,
                input: serde_json::from_str(&required_string(item, "arguments")?)
                    .map_err(|_| NotTranslatable::new("invalid function arguments"))?,
            }),
            Some("reasoning") => {}
            _ => {
                return Err(NotTranslatable::new(
                    "native hosted tool output cannot translate to chat",
                ))
            }
        }
    }
    Ok(IrResponse {
        id: required_string(body, "id")?,
        model: body["model"].as_str().unwrap_or("").into(),
        stop_reason: if body["status"] == "incomplete" {
            IrStopReason::MaxTokens
        } else if content
            .iter()
            .any(|part| matches!(part, IrContent::ToolUse { .. }))
        {
            IrStopReason::ToolUse
        } else {
            IrStopReason::Stop
        },
        content,
        usage: super::ir::IrUsage {
            input_tokens: body["usage"]["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: body["usage"]["output_tokens"].as_u64().unwrap_or(0),
        },
    })
}

/// Parse a Responses content field (string or array of content parts).
fn parse_content(content: Option<&Value>) -> Result<Vec<IrContent>, NotTranslatable> {
    match content {
        Some(Value::String(text)) => Ok(vec![IrContent::Text(text.clone())]),
        Some(Value::Array(parts)) => {
            let mut out = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("input_text") | Some("output_text") | Some("text") => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            out.push(IrContent::Text(text.to_string()));
                        }
                    }
                    Some("input_image") => {
                        if let Some(url) = image_url(part) {
                            out.push(IrContent::Image(super::openai::parse_openai_image(
                                &json!(url),
                            )?));
                        } else {
                            return Err(NotTranslatable::new(
                                "input_image without a resolvable image_url is not supported"
                                    .to_string(),
                            ));
                        }
                    }
                    Some(other) => {
                        return Err(NotTranslatable::new(format!(
                            "content part type \"{other}\" is not supported"
                        )))
                    }
                    None => {}
                }
            }
            Ok(out)
        }
        Some(Value::Null) | None => Ok(Vec::new()),
        Some(other) => Err(NotTranslatable::new(format!(
            "unsupported content shape: {other}"
        ))),
    }
}

/// Resolve an `input_image` part's URL — accepts `image_url` as a bare string
/// or as `{ url }`.
fn image_url(part: &Value) -> Option<String> {
    match part.get("image_url") {
        Some(Value::String(url)) => Some(url.clone()),
        Some(obj) => obj.get("url").and_then(Value::as_str).map(str::to_string),
        None => None,
    }
}

/// Render a Responses object from the upstream canonical [`IrResponse`].
pub fn response_from_ir(resp: &IrResponse, model: &str, created: i64) -> Value {
    let mut output = Vec::new();
    let text: String = resp
        .content
        .iter()
        .filter_map(|part| {
            if let IrContent::Text(t) = part {
                Some(t.as_str())
            } else {
                None
            }
        })
        .collect();
    if !text.is_empty() {
        output.push(json!({"type":"message","id":format!("msg_{}",uuid::Uuid::new_v4().simple()),"status":"completed","role":"assistant",
            "content":[{"type":"output_text","text":text,"annotations":[]}]}));
    }
    for part in &resp.content {
        if let IrContent::ToolUse { id, name, input } = part {
            output.push(json!({"type":"function_call","id":format!("fc_{}",uuid::Uuid::new_v4().simple()),"status":"completed",
                "call_id":id,"name":name,"arguments":input.to_string()}));
        }
    }
    let status = match resp.stop_reason {
        IrStopReason::MaxTokens => "incomplete",
        _ => "completed",
    };
    let response_id = format!("resp_{}", uuid::Uuid::new_v4().simple());

    let mut out = json!({
        "id": response_id,
        "object": "response",
        "created_at": created,
        "status": status,
        "model": model,
        "output": output,
        "usage": {
            "input_tokens": resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
            "total_tokens": resp.usage.input_tokens + resp.usage.output_tokens,
        },
    });
    if status == "incomplete" {
        out["incomplete_details"] = json!({ "reason": "max_output_tokens" });
    }
    out
}

/// Convert wrapped custom functions back to Responses free-form tool calls.
pub fn restore_custom_tools(response: &mut Value, names: &[String]) -> Result<(), String> {
    if let Some(items) = response["output"].as_array_mut() {
        for item in items {
            if item["type"] == "function_call" && names.iter().any(|n| item["name"] == *n) {
                let args: Value = serde_json::from_str(item["arguments"].as_str().unwrap_or(""))
                    .map_err(|_| "custom tool arguments are not JSON")?;
                let input = args["input"]
                    .as_str()
                    .ok_or("custom tool input is not a string")?
                    .to_string();
                item["type"] = json!("custom_tool_call");
                item["input"] = json!(input);
                item.as_object_mut().unwrap().remove("arguments");
            }
        }
    }
    Ok(())
}

/// Incremental Chat SSE → Responses SSE. Completion requires an upstream
/// terminal marker; EOF/error never becomes a false completed response.
pub struct ResponsesStream {
    pub response: Value,
    sequence: u64,
    started: bool,
    pub finished: bool,
    text_index: Option<usize>,
    reasoning_index: Option<usize>,
    tool_indices: std::collections::BTreeMap<u64, usize>,
    custom_tools: Vec<String>,
    namespaces: std::collections::BTreeMap<String, (String, String)>,
    stop_reason: Option<String>,
}
impl ResponsesStream {
    pub fn new(model: &str, custom_tools: Vec<String>) -> Self {
        Self {
            response: json!({"id":format!("resp_{}",uuid::Uuid::new_v4().simple()),"object":"response",
                "created_at":chrono::Utc::now().timestamp(),"status":"in_progress","model":model,"output":[],
                "usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}),
            sequence: 0,
            started: false,
            finished: false,
            text_index: None,
            reasoning_index: None,
            tool_indices: Default::default(),
            custom_tools,
            namespaces: Default::default(),
            stop_reason: None,
        }
    }
    pub fn with_namespaces(
        mut self,
        namespaces: std::collections::BTreeMap<String, (String, String)>,
    ) -> Self {
        self.namespaces = namespaces;
        self
    }
    fn event(&mut self, kind: &str, mut payload: Value) -> String {
        payload["type"] = json!(kind);
        payload["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        format!("event: {kind}\ndata: {payload}\n\n")
    }
    pub fn start(&mut self) -> Vec<String> {
        if self.started {
            return vec![];
        }
        self.started = true;
        vec![
            self.event("response.created", json!({"response":self.response})),
            self.event("response.in_progress", json!({"response":self.response})),
        ]
    }
    fn add_item(&mut self, mut item: Value, out: &mut Vec<String>) -> usize {
        restore_item_namespace(&mut item, &self.namespaces);
        let items = self.response["output"].as_array_mut().unwrap();
        let index = items.len();
        items.push(item.clone());
        out.push(self.event(
            "response.output_item.added",
            json!({"output_index":index,"item":item}),
        ));
        index
    }
    pub fn push(&mut self, payload: &str) -> Vec<String> {
        if self.finished {
            return vec![];
        }
        let mut out = self.start();
        if payload == "[DONE]" {
            out.extend(self.complete());
            return out;
        }
        let value: Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => {
                out.extend(self.fail("malformed upstream stream event"));
                return out;
            }
        };
        if value.get("error").is_some() {
            out.extend(self.fail("upstream stream failed"));
            return out;
        }
        if let Some(usage) = value.get("usage") {
            if let Some(n) = usage["prompt_tokens"].as_u64() {
                self.response["usage"]["input_tokens"] = json!(n);
            }
            if let Some(n) = usage["completion_tokens"].as_u64() {
                self.response["usage"]["output_tokens"] = json!(n);
            }
        }
        let delta = &value["choices"][0]["delta"];
        if let Some(reason) = value["choices"][0]["finish_reason"].as_str() {
            self.stop_reason = Some(reason.to_string());
        }
        if let Some(text) = delta["reasoning_content"]
            .as_str()
            .or_else(|| delta["reasoning"].as_str())
        {
            if !text.is_empty() {
                let index = if let Some(i) = self.reasoning_index {
                    i
                } else {
                    let i = self.add_item(json!({"id":format!("rs_{}",uuid::Uuid::new_v4().simple()),"type":"reasoning","summary":[{"type":"summary_text","text":""}]}),&mut out);
                    self.reasoning_index = Some(i);
                    out.push(self.event("response.reasoning_summary_part.added",json!({"item_id":self.response["output"][i]["id"],"output_index":i,"summary_index":0,"part":{"type":"summary_text","text":""}})));
                    i
                };
                let previous = self.response["output"][index]["summary"][0]["text"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                self.response["output"][index]["summary"][0]["text"] = json!(previous + text);
                out.push(self.event("response.reasoning_summary_text.delta",json!({"item_id":self.response["output"][index]["id"],"output_index":index,"summary_index":0,"delta":text})));
            }
        }
        if let Some(text) = delta["content"].as_str().filter(|s| !s.is_empty()) {
            let index = if let Some(i) = self.text_index {
                i
            } else {
                let i = self.add_item(json!({"id":format!("msg_{}",uuid::Uuid::new_v4().simple()),"type":"message","status":"in_progress","role":"assistant","content":[{"type":"output_text","text":"","annotations":[]}]}),&mut out);
                self.text_index = Some(i);
                out.push(self.event("response.content_part.added",json!({"item_id":self.response["output"][i]["id"],"output_index":i,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})));
                i
            };
            let previous = self.response["output"][index]["content"][0]["text"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            self.response["output"][index]["content"][0]["text"] = json!(previous + text);
            out.push(self.event("response.output_text.delta",json!({"item_id":self.response["output"][index]["id"],"output_index":index,"content_index":0,"delta":text})));
        }
        for tool in delta["tool_calls"].as_array().into_iter().flatten() {
            let key = tool["index"].as_u64().unwrap_or(0);
            let index = if let Some(index) = self.tool_indices.get(&key) {
                *index
            } else {
                let name = tool["function"]["name"].as_str().unwrap_or("");
                let custom = self.custom_tools.iter().any(|n| n == name);
                let i = self.add_item(json!({"id":format!("fc_{}",uuid::Uuid::new_v4().simple()),"type":if custom {"custom_tool_call"} else {"function_call"},"status":"in_progress","call_id":tool["id"].as_str().unwrap_or(""),"name":name,"arguments":""}),&mut out);
                self.tool_indices.insert(key, i);
                i
            };
            if let Some(id) = tool["id"].as_str() {
                self.response["output"][index]["call_id"] = json!(id);
            }
            if let Some(name) = tool["function"]["name"].as_str() {
                self.response["output"][index]["name"] = json!(name);
                restore_item_namespace(&mut self.response["output"][index], &self.namespaces);
            }
            if let Some(args) = tool["function"]["arguments"].as_str() {
                let previous = self.response["output"][index]["arguments"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                self.response["output"][index]["arguments"] = json!(previous + args);
                if self.response["output"][index]["type"] == "function_call" {
                    out.push(self.event("response.function_call_arguments.delta",json!({"item_id":self.response["output"][index]["id"],"output_index":index,"delta":args})));
                }
            }
        }
        out
    }
    fn complete(&mut self) -> Vec<String> {
        if self.stop_reason.is_none() {
            return self.fail("upstream ended without a finish reason");
        }
        let mut out = Vec::new();
        let count = self.response["output"].as_array().unwrap().len();
        for index in 0..count {
            let mut item = self.response["output"][index].clone();
            let common = json!({"item_id":item["id"],"output_index":index});
            match item["type"].as_str().unwrap_or("") {
                "message" => {
                    let mut data = common.clone();
                    data["content_index"] = json!(0);
                    data["text"] = item["content"][0]["text"].clone();
                    out.push(self.event("response.output_text.done", data));
                    let mut data = common.clone();
                    data["content_index"] = json!(0);
                    data["part"] = item["content"][0].clone();
                    out.push(self.event("response.content_part.done", data));
                }
                "reasoning" => {
                    let mut data = common.clone();
                    data["summary_index"] = json!(0);
                    data["text"] = item["summary"][0]["text"].clone();
                    out.push(self.event("response.reasoning_summary_text.done", data));
                    let mut data = common.clone();
                    data["summary_index"] = json!(0);
                    data["part"] = item["summary"][0].clone();
                    out.push(self.event("response.reasoning_summary_part.done", data));
                }
                "function_call" => {
                    let mut data = common.clone();
                    data["arguments"] = item["arguments"].clone();
                    out.push(self.event("response.function_call_arguments.done", data));
                }
                "custom_tool_call" => {
                    let args: Value =
                        match serde_json::from_str(item["arguments"].as_str().unwrap_or("")) {
                            Ok(v) => v,
                            Err(_) => return self.fail("invalid custom tool JSON"),
                        };
                    let Some(input) = args["input"].as_str() else {
                        return self.fail("invalid custom tool input");
                    };
                    item["input"] = json!(input);
                    item.as_object_mut().unwrap().remove("arguments");
                    let mut data = common.clone();
                    data["delta"] = json!(input);
                    out.push(self.event("response.custom_tool_call_input.delta", data));
                    let mut data = common;
                    data["input"] = json!(input);
                    out.push(self.event("response.custom_tool_call_input.done", data));
                }
                _ => {}
            }
            item["status"] = json!("completed");
            self.response["output"][index] = item.clone();
            out.push(self.event(
                "response.output_item.done",
                json!({"output_index":index,"item":item}),
            ));
        }
        let incomplete = self.stop_reason.as_deref() == Some("length");
        self.response["status"] = json!(if incomplete {
            "incomplete"
        } else {
            "completed"
        });
        if incomplete {
            self.response["incomplete_details"] = json!({"reason":"max_output_tokens"});
        }
        self.response["usage"]["total_tokens"] = json!(
            self.response["usage"]["input_tokens"].as_u64().unwrap_or(0)
                + self.response["usage"]["output_tokens"]
                    .as_u64()
                    .unwrap_or(0)
        );
        out.push(self.event(
            if incomplete {
                "response.incomplete"
            } else {
                "response.completed"
            },
            json!({"response":self.response}),
        ));
        self.finished = true;
        out
    }
    pub fn fail(&mut self, message: &str) -> Vec<String> {
        if self.finished {
            return vec![];
        }
        self.finished = true;
        self.response["status"] = json!("failed");
        self.response["error"] = json!({"code":"server_error","message":message});
        vec![self.event("response.failed", json!({"response":self.response}))]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_tools_restore_namespace_and_name_on_stream_events() {
        let body = json!({"model":"m","input":"hi","tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]}]});
        let chat = to_chat(&body).unwrap();
        let wire_name = chat["tools"][0]["function"]["name"].as_str().unwrap();
        assert!(wire_name.starts_with("cognia_ns_"));
        let mut encoder =
            ResponsesStream::new("m", Vec::new()).with_namespaces(tool_namespaces(&body));
        encoder.push(&json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":wire_name,"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}).to_string());
        encoder.push("[DONE]");
        assert_eq!(encoder.response["output"][0]["namespace"], "functions");
        assert_eq!(encoder.response["output"][0]["name"], "read");
    }

    #[test]
    fn responses_stream_preserves_fragments_and_never_completes_a_truncated_turn() {
        let mut stream = ResponsesStream::new("model", Vec::new());
        let mut frames = stream.push(
            &json!({"choices":[{"delta":{"content":"你"},"finish_reason":null}]}).to_string(),
        );
        frames.extend(stream.push(&json!({"choices":[{"delta":{"content":"好"},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}).to_string()));
        frames.extend(stream.push("[DONE]"));
        assert_eq!(stream.response["output"][0]["content"][0]["text"], "你好");
        assert_eq!(stream.response["status"], "incomplete");
        for (index, frame) in frames.iter().enumerate() {
            let data = frame
                .lines()
                .find_map(|l| l.strip_prefix("data: "))
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(data).unwrap()["sequence_number"],
                index
            );
        }
        let mut truncated = ResponsesStream::new("model", Vec::new());
        let frames = truncated.push("[DONE]");
        assert!(frames.last().unwrap().contains("response.failed"));
        assert!(!frames
            .iter()
            .any(|frame| frame.contains("response.completed")));
    }

    #[test]
    fn function_and_custom_tool_results_roundtrip_through_chat() {
        let body = json!({"model":"model","input":[
            {"role":"user","content":"patch"},
            {"type":"custom_tool_call","call_id":"c1","name":"patch","input":"raw patch"},
            {"type":"custom_tool_call_output","call_id":"c1","output":"applied"}],
            "tools":[{"type":"custom","name":"patch","format":{"type":"text"}}]});
        let chat = to_chat(&body).unwrap();
        assert!(chat["messages"].to_string().contains("raw patch"));
        assert!(chat["messages"].to_string().contains("applied"));
        let ir = super::super::openai::to_ir(&chat).unwrap();
        let native = request_from_ir(&ir);
        assert_eq!(native["input"][1]["type"], "function_call");
        assert_eq!(native["input"][2]["call_id"], "c1");
    }

    #[test]
    fn unsupported_features_are_flagged() {
        assert!(unsupported_feature(&json!({ "stream": true })).is_none());
        assert!(unsupported_feature(&json!({ "tools": [{ "type": "function" }] })).is_none());
        assert!(unsupported_feature(&json!({ "previous_response_id": "resp_1" })).is_none());
        assert!(unsupported_feature(&json!({ "background": true })).is_some());
        // Supported request → None.
        assert!(unsupported_feature(&json!({ "model": "m", "input": "hi" })).is_none());
        // Null / absent unsupported fields are fine.
        assert!(
            unsupported_feature(&json!({ "tools": null, "previous_response_id": null })).is_none()
        );
    }

    #[test]
    fn string_input_becomes_single_user_message() {
        let ir = request_to_ir(&json!({ "model": "gpt", "input": "hello" })).unwrap();
        assert_eq!(ir.model, "gpt");
        assert_eq!(ir.messages.len(), 1);
        assert_eq!(ir.messages[0].role, IrRole::User);
        assert_eq!(
            ir.messages[0].content,
            vec![IrContent::Text("hello".into())]
        );
        assert!(ir.system.is_none());
        assert!(!ir.stream);
    }

    #[test]
    fn instructions_and_options_map_across() {
        let ir = request_to_ir(&json!({
            "model": "m",
            "instructions": "be terse",
            "input": "hi",
            "max_output_tokens": 64,
            "temperature": 0.3,
            "top_p": 0.9,
        }))
        .unwrap();
        assert_eq!(ir.system.as_deref(), Some("be terse"));
        assert_eq!(ir.max_tokens, Some(64));
        assert_eq!(ir.temperature, Some(0.3));
        assert_eq!(ir.top_p, Some(0.9));
    }

    #[test]
    fn array_input_with_roles_and_parts() {
        let ir = request_to_ir(&json!({
            "model": "m",
            "input": [
                { "role": "system", "content": "sys rule" },
                { "role": "user", "content": [
                    { "type": "input_text", "text": "look at this" },
                    { "type": "input_image", "image_url": "https://x/y.png" },
                ]},
                { "role": "assistant", "content": [{ "type": "output_text", "text": "ok" }] },
            ],
        }))
        .unwrap();
        assert_eq!(ir.system.as_deref(), Some("sys rule"));
        assert_eq!(ir.messages.len(), 2);
        assert_eq!(ir.messages[0].role, IrRole::User);
        assert_eq!(
            ir.messages[0].content[0],
            IrContent::Text("look at this".into())
        );
        assert_eq!(
            ir.messages[0].content[1],
            IrContent::Image(IrImage::Url("https://x/y.png".into()))
        );
        assert_eq!(ir.messages[1].role, IrRole::Assistant);
    }

    #[test]
    fn image_url_object_form() {
        let ir = request_to_ir(&json!({
            "model": "m",
            "input": [{ "role": "user", "content": [
                { "type": "input_image", "image_url": { "url": "https://a/b.jpg" } },
            ]}],
        }))
        .unwrap();
        assert_eq!(
            ir.messages[0].content[0],
            IrContent::Image(IrImage::Url("https://a/b.jpg".into()))
        );
    }

    #[test]
    fn rejects_missing_model_and_input() {
        assert!(request_to_ir(&json!({ "input": "x" })).is_err());
        assert!(request_to_ir(&json!({ "model": "m" })).is_err());
        assert!(request_to_ir(&json!({ "model": "", "input": "x" })).is_err());
    }

    #[test]
    fn rejects_non_message_items_and_unknown_parts() {
        assert!(request_to_ir(&json!({
            "model": "m",
            "input": [{ "type": "function_call", "name": "f" }],
        }))
        .is_err());
        assert!(request_to_ir(&json!({
            "model": "m",
            "input": [{ "role": "user", "content": [{ "type": "input_audio" }] }],
        }))
        .is_err());
    }

    #[test]
    fn response_from_ir_completed_shape() {
        let resp = IrResponse {
            id: "up-1".into(),
            model: "gpt".into(),
            content: vec![IrContent::Text("the answer".into())],
            stop_reason: IrStopReason::Stop,
            usage: super::super::ir::IrUsage {
                input_tokens: 5,
                output_tokens: 3,
            },
        };
        let out = response_from_ir(&resp, "my-alias", 1234);
        assert_eq!(out["object"], "response");
        assert_eq!(out["status"], "completed");
        assert_eq!(out["model"], "my-alias");
        assert_eq!(out["created_at"], 1234);
        assert!(out["id"].as_str().unwrap().starts_with("resp_"));
        assert_eq!(out["output"][0]["type"], "message");
        assert_eq!(out["output"][0]["role"], "assistant");
        assert_eq!(out["output"][0]["content"][0]["type"], "output_text");
        assert_eq!(out["output"][0]["content"][0]["text"], "the answer");
        assert_eq!(out["usage"]["input_tokens"], 5);
        assert_eq!(out["usage"]["output_tokens"], 3);
        assert_eq!(out["usage"]["total_tokens"], 8);
        assert!(out.get("incomplete_details").is_none());
    }

    #[test]
    fn response_from_ir_incomplete_on_max_tokens() {
        let resp = IrResponse {
            id: "up-2".into(),
            model: "gpt".into(),
            content: vec![IrContent::Text("truncat".into())],
            stop_reason: IrStopReason::MaxTokens,
            usage: super::super::ir::IrUsage::default(),
        };
        let out = response_from_ir(&resp, "m", 0);
        assert_eq!(out["status"], "incomplete");
        assert_eq!(out["incomplete_details"]["reason"], "max_output_tokens");
    }
}
