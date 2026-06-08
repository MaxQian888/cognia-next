//! Streaming protocol transcoder — converts upstream SSE chunks into the
//! inbound format's wire events AS THEY ARRIVE (new-api `HandleStreamFormat`
//! analog). A pull state machine: the executor de-frames upstream SSE,
//! feeds each data payload to `push`, writes the returned frames to the
//! client, and calls `finish` when the upstream ends.
//!
//! Directions (same-format pairs bypass the transcoder entirely):
//!   - OpenAiToAnthropic: openai-protocol upstream → Anthropic client
//!     (the Claude-Code-CLI-on-any-provider path)
//!   - AnthropicToOpenAi: anthropic-protocol upstream → OpenAI client
//!
//! The hard part is fragmented tool calls: OpenAI streams `arguments` as
//! string fragments on indexed `tool_calls` deltas; Anthropic streams
//! `input_json_delta.partial_json` on indexed content blocks. Both sides
//! accumulate per-index state here.

use serde_json::{json, Value};

use super::ir::{IrStopReason, IrUsage};

/// One outbound SSE frame. Anthropic frames carry an `event:` name; OpenAI
/// frames are data-only (the terminal frame is the literal `[DONE]`).
#[derive(Debug, Clone, PartialEq)]
pub struct SseOut {
    pub event: Option<String>,
    pub data: String,
}

impl SseOut {
    fn json(event: Option<&str>, data: Value) -> Self {
        Self {
            event: event.map(|e| e.to_string()),
            data: data.to_string(),
        }
    }

    pub fn done() -> Self {
        Self {
            event: None,
            data: "[DONE]".to_string(),
        }
    }

    /// Serialize to wire bytes (`event:` line when named, then `data:`).
    pub fn to_frame(&self) -> String {
        match &self.event {
            Some(event) => format!("event: {event}\ndata: {}\n\n", self.data),
            None => format!("data: {}\n\n", self.data),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    OpenAiToAnthropic,
    AnthropicToOpenAi,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum OpenBlock {
    None,
    Text { index: u64 },
    Tool { index: u64 },
}

pub struct StreamTranscoder {
    direction: Direction,
    /// Model id reported to the client (the one the CLIENT asked for).
    client_model: String,
    started: bool,
    finished: bool,
    open_block: OpenBlock,
    next_block_index: u64,
    /// openai tool_calls index → anthropic content-block index.
    tool_block_index: std::collections::HashMap<u64, u64>,
    /// anthropic content-block index → openai tool_calls index.
    openai_tool_index: std::collections::HashMap<u64, u64>,
    next_openai_tool_index: u64,
    stop_reason: Option<IrStopReason>,
    usage: IrUsage,
    message_id: String,
}

impl StreamTranscoder {
    pub fn new(direction: Direction, client_model: impl Into<String>, message_id: impl Into<String>) -> Self {
        Self {
            direction,
            client_model: client_model.into(),
            started: false,
            finished: false,
            open_block: OpenBlock::None,
            next_block_index: 0,
            tool_block_index: std::collections::HashMap::new(),
            openai_tool_index: std::collections::HashMap::new(),
            next_openai_tool_index: 0,
            stop_reason: None,
            usage: IrUsage::default(),
            message_id: message_id.into(),
        }
    }

    /// Token usage harvested from the stream (for telemetry, post-finish).
    pub fn usage(&self) -> IrUsage {
        self.usage
    }

    /// Feed one upstream data payload (already de-framed, JSON-parsed).
    pub fn push(&mut self, data: &Value) -> Vec<SseOut> {
        match self.direction {
            Direction::OpenAiToAnthropic => self.push_openai_chunk(data),
            Direction::AnthropicToOpenAi => self.push_anthropic_event(data),
        }
    }

    /// Upstream ended — emit the trailing frames for the inbound format.
    pub fn finish(&mut self) -> Vec<SseOut> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out = Vec::new();
        match self.direction {
            Direction::OpenAiToAnthropic => {
                self.ensure_started_anthropic(&mut out);
                self.close_open_block(&mut out);
                let stop = self.stop_reason.unwrap_or(IrStopReason::Stop);
                out.push(SseOut::json(
                    Some("message_delta"),
                    json!({
                        "type": "message_delta",
                        "delta": { "stop_reason": stop.to_anthropic(), "stop_sequence": null },
                        "usage": { "output_tokens": self.usage.output_tokens },
                    }),
                ));
                out.push(SseOut::json(
                    Some("message_stop"),
                    json!({ "type": "message_stop" }),
                ));
            }
            Direction::AnthropicToOpenAi => {
                let stop = self.stop_reason.unwrap_or(IrStopReason::Stop);
                out.push(SseOut::json(
                    None,
                    json!({
                        "id": self.message_id,
                        "object": "chat.completion.chunk",
                        "model": self.client_model,
                        "choices": [{ "index": 0, "delta": {}, "finish_reason": stop.to_openai() }],
                        "usage": {
                            "prompt_tokens": self.usage.input_tokens,
                            "completion_tokens": self.usage.output_tokens,
                            "total_tokens": self.usage.input_tokens + self.usage.output_tokens,
                        }
                    }),
                ));
                out.push(SseOut::done());
            }
        }
        out
    }

    // ---- openai upstream → anthropic client --------------------------------

    fn ensure_started_anthropic(&mut self, out: &mut Vec<SseOut>) {
        if self.started {
            return;
        }
        self.started = true;
        out.push(SseOut::json(
            Some("message_start"),
            json!({
                "type": "message_start",
                "message": {
                    "id": self.message_id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.client_model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": self.usage.input_tokens, "output_tokens": 0 },
                }
            }),
        ));
    }

    fn close_open_block(&mut self, out: &mut Vec<SseOut>) {
        let index = match self.open_block {
            OpenBlock::None => return,
            OpenBlock::Text { index } | OpenBlock::Tool { index } => index,
        };
        out.push(SseOut::json(
            Some("content_block_stop"),
            json!({ "type": "content_block_stop", "index": index }),
        ));
        self.open_block = OpenBlock::None;
    }

    fn push_openai_chunk(&mut self, chunk: &Value) -> Vec<SseOut> {
        let mut out = Vec::new();

        // The include_usage trailer (and some providers' final chunk) carries
        // usage — harvest whenever present.
        if let Some(usage) = chunk.get("usage").filter(|u| !u.is_null()) {
            if let Some(p) = usage["prompt_tokens"].as_u64() {
                self.usage.input_tokens = p;
            }
            if let Some(c) = usage["completion_tokens"].as_u64() {
                self.usage.output_tokens = c;
            }
        }

        let Some(choice) = chunk["choices"].as_array().and_then(|c| c.first()) else {
            return out;
        };
        self.ensure_started_anthropic(&mut out);

        if let Some(reason) = choice["finish_reason"].as_str() {
            self.stop_reason = Some(IrStopReason::from_openai(reason));
        }

        let delta = &choice["delta"];

        // Text deltas.
        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                if !matches!(self.open_block, OpenBlock::Text { .. }) {
                    self.close_open_block(&mut out);
                    let index = self.next_block_index;
                    self.next_block_index += 1;
                    self.open_block = OpenBlock::Text { index };
                    out.push(SseOut::json(
                        Some("content_block_start"),
                        json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": { "type": "text", "text": "" },
                        }),
                    ));
                }
                if let OpenBlock::Text { index } = self.open_block {
                    out.push(SseOut::json(
                        Some("content_block_delta"),
                        json!({
                            "type": "content_block_delta",
                            "index": index,
                            "delta": { "type": "text_delta", "text": text },
                        }),
                    ));
                }
            }
        }

        // Fragmented tool calls.
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let oa_index = call["index"].as_u64().unwrap_or(0);
                let is_new = call["id"].as_str().is_some()
                    || call["function"]["name"].as_str().is_some();
                if is_new && !self.tool_block_index.contains_key(&oa_index) {
                    self.close_open_block(&mut out);
                    let index = self.next_block_index;
                    self.next_block_index += 1;
                    self.tool_block_index.insert(oa_index, index);
                    self.open_block = OpenBlock::Tool { index };
                    out.push(SseOut::json(
                        Some("content_block_start"),
                        json!({
                            "type": "content_block_start",
                            "index": index,
                            "content_block": {
                                "type": "tool_use",
                                "id": call["id"].as_str().unwrap_or(""),
                                "name": call["function"]["name"].as_str().unwrap_or(""),
                                "input": {},
                            },
                        }),
                    ));
                }
                if let Some(fragment) = call["function"]["arguments"].as_str() {
                    if !fragment.is_empty() {
                        if let Some(&index) = self.tool_block_index.get(&oa_index) {
                            out.push(SseOut::json(
                                Some("content_block_delta"),
                                json!({
                                    "type": "content_block_delta",
                                    "index": index,
                                    "delta": { "type": "input_json_delta", "partial_json": fragment },
                                }),
                            ));
                        }
                    }
                }
            }
        }

        out
    }

    // ---- anthropic upstream → openai client --------------------------------

    fn push_anthropic_event(&mut self, event: &Value) -> Vec<SseOut> {
        let mut out = Vec::new();
        match event["type"].as_str() {
            Some("message_start") => {
                if let Some(p) = event["message"]["usage"]["input_tokens"].as_u64() {
                    self.usage.input_tokens = p;
                }
                if !self.started {
                    self.started = true;
                    out.push(self.openai_chunk(json!({ "role": "assistant", "content": "" }), None));
                }
            }
            Some("content_block_start") => {
                let block = &event["content_block"];
                if block["type"].as_str() == Some("tool_use") {
                    let an_index = event["index"].as_u64().unwrap_or(0);
                    let oa_index = self.next_openai_tool_index;
                    self.next_openai_tool_index += 1;
                    self.openai_tool_index.insert(an_index, oa_index);
                    out.push(self.openai_chunk(
                        json!({ "tool_calls": [{
                            "index": oa_index,
                            "id": block["id"].as_str().unwrap_or(""),
                            "type": "function",
                            "function": {
                                "name": block["name"].as_str().unwrap_or(""),
                                "arguments": "",
                            },
                        }]}),
                        None,
                    ));
                }
            }
            Some("content_block_delta") => match event["delta"]["type"].as_str() {
                Some("text_delta") => {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        out.push(self.openai_chunk(json!({ "content": text }), None));
                    }
                }
                Some("input_json_delta") => {
                    let an_index = event["index"].as_u64().unwrap_or(0);
                    if let Some(&oa_index) = self.openai_tool_index.get(&an_index) {
                        let fragment = event["delta"]["partial_json"].as_str().unwrap_or("");
                        out.push(self.openai_chunk(
                            json!({ "tool_calls": [{
                                "index": oa_index,
                                "function": { "arguments": fragment },
                            }]}),
                            None,
                        ));
                    }
                }
                _ => {}
            },
            Some("message_delta") => {
                if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(IrStopReason::from_anthropic(reason));
                }
                if let Some(c) = event["usage"]["output_tokens"].as_u64() {
                    self.usage.output_tokens = c;
                }
            }
            // ping / content_block_stop / message_stop carry nothing the
            // openai shape needs mid-stream; finish() emits the trailer.
            _ => {}
        }
        out
    }

    fn openai_chunk(&self, delta: Value, finish_reason: Option<&str>) -> SseOut {
        SseOut::json(
            None,
            json!({
                "id": self.message_id,
                "object": "chat.completion.chunk",
                "model": self.client_model,
                "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(out: &SseOut) -> Value {
        serde_json::from_str(&out.data).unwrap()
    }

    fn events(outs: &[SseOut]) -> Vec<String> {
        outs.iter()
            .map(|o| {
                o.event
                    .clone()
                    .unwrap_or_else(|| parse_type(o).unwrap_or_else(|| "data".into()))
            })
            .collect()
    }

    fn parse_type(out: &SseOut) -> Option<String> {
        serde_json::from_str::<Value>(&out.data)
            .ok()
            .and_then(|v| v["type"].as_str().map(|s| s.to_string()))
    }

    #[test]
    fn openai_to_anthropic_golden_text_sequence() {
        let mut t = StreamTranscoder::new(Direction::OpenAiToAnthropic, "alias-model", "msg_1");
        let mut all = Vec::new();
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "content": "Hel" } }] })));
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "content": "lo" } }] })));
        all.extend(t.push(&json!({
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 9, "completion_tokens": 2 }
        })));
        all.extend(t.finish());

        assert_eq!(
            events(&all),
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        // Deltas carry the text.
        assert_eq!(parse(&all[2])["delta"]["text"], "Hel");
        assert_eq!(parse(&all[3])["delta"]["text"], "lo");
        // Trailer carries stop reason + output tokens.
        assert_eq!(parse(&all[5])["delta"]["stop_reason"], "end_turn");
        assert_eq!(parse(&all[5])["usage"]["output_tokens"], 2);
        assert_eq!(t.usage(), IrUsage { input_tokens: 9, output_tokens: 2 });
        // SSE framing includes the event name line.
        assert!(all[0].to_frame().starts_with("event: message_start\ndata: "));
    }

    #[test]
    fn openai_to_anthropic_fragmented_tool_call() {
        let mut t = StreamTranscoder::new(Direction::OpenAiToAnthropic, "m", "msg_1");
        let mut all = Vec::new();
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "content": "checking" } }] })));
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
            "index": 0, "id": "call_1", "type": "function",
            "function": { "name": "get_weather", "arguments": "" }
        }]}}]})));
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
            "index": 0, "function": { "arguments": "{\"ci" }
        }]}}]})));
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{
            "index": 0, "function": { "arguments": "ty\":\"SF\"}" }
        }]}}]})));
        all.extend(t.push(&json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] })));
        all.extend(t.finish());

        let names = events(&all);
        assert_eq!(
            names,
            vec![
                "message_start",
                "content_block_start",  // text
                "content_block_delta",  // "checking"
                "content_block_stop",   // text closed by tool start
                "content_block_start",  // tool_use
                "content_block_delta",  // partial 1
                "content_block_delta",  // partial 2
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        // Tool block carries id/name; deltas accumulate the SAME index.
        let start = parse(&all[4]);
        assert_eq!(start["content_block"]["type"], "tool_use");
        assert_eq!(start["content_block"]["id"], "call_1");
        assert_eq!(start["content_block"]["name"], "get_weather");
        let d1 = parse(&all[5]);
        let d2 = parse(&all[6]);
        assert_eq!(d1["index"], start["index"]);
        assert_eq!(d1["delta"]["type"], "input_json_delta");
        let joined = format!(
            "{}{}",
            d1["delta"]["partial_json"].as_str().unwrap(),
            d2["delta"]["partial_json"].as_str().unwrap()
        );
        assert_eq!(joined, "{\"city\":\"SF\"}");
        assert_eq!(parse(&all[8])["delta"]["stop_reason"], "tool_use");
    }

    #[test]
    fn anthropic_to_openai_golden_sequence() {
        let mut t = StreamTranscoder::new(Direction::AnthropicToOpenAi, "claude-x", "chatcmpl-1");
        let mut all = Vec::new();
        all.extend(t.push(&json!({ "type": "message_start", "message": {
            "id": "msg_1", "usage": { "input_tokens": 11, "output_tokens": 0 } } })));
        all.extend(t.push(&json!({ "type": "ping" })));
        all.extend(t.push(&json!({ "type": "content_block_start", "index": 0,
            "content_block": { "type": "text", "text": "" } })));
        all.extend(t.push(&json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" } })));
        all.extend(t.push(&json!({ "type": "content_block_stop", "index": 0 })));
        all.extend(t.push(&json!({ "type": "message_delta",
            "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 4 } })));
        all.extend(t.push(&json!({ "type": "message_stop" })));
        all.extend(t.finish());

        // role chunk, text chunk, final chunk, [DONE]
        assert_eq!(all.len(), 4);
        assert_eq!(parse(&all[0])["choices"][0]["delta"]["role"], "assistant");
        assert_eq!(parse(&all[1])["choices"][0]["delta"]["content"], "Hi");
        let last = parse(&all[2]);
        assert_eq!(last["choices"][0]["finish_reason"], "stop");
        assert_eq!(last["usage"]["prompt_tokens"], 11);
        assert_eq!(last["usage"]["completion_tokens"], 4);
        assert_eq!(all[3], SseOut::done());
        assert!(all[3].to_frame().ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn anthropic_to_openai_fragmented_tool_call() {
        let mut t = StreamTranscoder::new(Direction::AnthropicToOpenAi, "m", "chatcmpl-1");
        let mut all = Vec::new();
        all.extend(t.push(&json!({ "type": "message_start", "message": { "usage": { "input_tokens": 1 } } })));
        all.extend(t.push(&json!({ "type": "content_block_start", "index": 0,
            "content_block": { "type": "tool_use", "id": "tu_1", "name": "t", "input": {} } })));
        all.extend(t.push(&json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": "{\"a\"" } })));
        all.extend(t.push(&json!({ "type": "content_block_delta", "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": ":1}" } })));
        all.extend(t.push(&json!({ "type": "message_delta",
            "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 2 } })));
        all.extend(t.finish());

        let tool_start = parse(&all[1]);
        let calls = &tool_start["choices"][0]["delta"]["tool_calls"][0];
        assert_eq!(calls["id"], "tu_1");
        assert_eq!(calls["function"]["name"], "t");
        let f1 = parse(&all[2])["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .to_string();
        let f2 = parse(&all[3])["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(format!("{f1}{f2}"), "{\"a\":1}");
        assert_eq!(parse(&all[4])["choices"][0]["finish_reason"], "tool_calls");
    }

    #[test]
    fn finish_is_idempotent_and_defaults_stop() {
        let mut t = StreamTranscoder::new(Direction::OpenAiToAnthropic, "m", "msg_1");
        let first = t.finish();
        // Even with zero chunks the anthropic client gets a valid envelope.
        assert_eq!(
            events(&first),
            vec!["message_start", "message_delta", "message_stop"]
        );
        assert!(t.finish().is_empty());
    }
}
