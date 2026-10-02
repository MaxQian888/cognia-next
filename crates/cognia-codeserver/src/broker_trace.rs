//! The Managed IDE Dev Mode broker trace.
//!
//! While Dev Mode is on, every frame the agent channel exchanges with an
//! editor is recorded here: direction, kind, method, JSON-RPC id, connection
//! generation, size, the round-trip time of a request once it is answered,
//! and the error code of a refusal. It feeds the Plugin DevTools "Managed IDE"
//! panel through `codeserver_broker_trace` and the
//! [`CODESERVER_BROKER_TRACE_EVENT`] stream.
//!
//! Payloads are redacted by default: only their shape is kept (object keys,
//! array lengths, the type of every leaf), never a value. Showing values is a
//! separate opt-in; the renderer then runs them through `packages/redact`
//! before display. Off (the default), nothing is recorded at all and the ring
//! is emptied, so a trace never outlives the session that asked for it.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

/// Renderer event carrying one new [`TraceEntry`].
pub const CODESERVER_BROKER_TRACE_EVENT: &str = "codeserver://broker-trace";

/// Entries kept; the oldest go first.
pub const TRACE_CAPACITY: usize = 2_000;

/// How deep a payload's shape is described before it is cut off.
const SHAPE_DEPTH: usize = 6;
/// How many keys of one object a shape lists.
const SHAPE_KEYS: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceDirection {
    /// Host → editor.
    Outbound,
    /// Editor → host.
    Inbound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceKind {
    Request,
    Response,
    Notification,
    Event,
}

/// One recorded frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEntry {
    /// Monotonic within the process; a client resumes from the last it saw.
    pub seq: u64,
    pub at_ms: u64,
    pub root: String,
    /// The connection generation the frame travelled on.
    pub generation: u64,
    pub direction: TraceDirection,
    pub kind: TraceKind,
    /// The method, or for a response, the method it answers when known.
    pub method: Option<String>,
    pub id: Option<String>,
    /// The plugin a managed proxy frame is about. An identifier, not content,
    /// so it is kept even when the payload is reduced to its shape.
    pub plugin_id: Option<String>,
    /// Serialized size of the frame, in bytes.
    pub bytes: usize,
    /// For a response: how long its request was outstanding.
    pub duration_ms: Option<u64>,
    pub error_code: Option<i64>,
    /// The payload's shape, or its values when the session opted in.
    pub payload: Option<Value>,
}

/// What a frame looked like, before the ring decides what to keep.
#[derive(Debug, Clone)]
pub struct TraceFrame<'a> {
    pub root: &'a str,
    pub generation: u64,
    pub direction: TraceDirection,
    pub kind: TraceKind,
    pub method: Option<&'a str>,
    pub id: Option<String>,
    pub bytes: usize,
    pub duration_ms: Option<u64>,
    pub error_code: Option<i64>,
    pub payload: Option<&'a Value>,
}

/// Whether recording is on, and whether it keeps payload values.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMode {
    pub enabled: bool,
    pub include_payloads: bool,
}

/// A request awaiting its response: (root, generation, id, request direction).
type OpenKey = (String, u64, String, TraceDirection);

#[derive(Default)]
struct Ring {
    mode: TraceMode,
    next_seq: u64,
    entries: VecDeque<TraceEntry>,
    /// Outstanding requests, so a response is labelled with its method and
    /// round-trip time. Bounded like the ring: a request never answered (its
    /// connection died) must not pin memory.
    open: HashMap<OpenKey, (Option<String>, Instant)>,
}

/// The bounded trace ring. Cheap when off: one lock and a flag check.
#[derive(Default)]
pub struct BrokerTrace {
    ring: Mutex<Ring>,
}

impl BrokerTrace {
    pub fn mode(&self) -> TraceMode {
        self.lock().mode
    }

    /// Turn recording on or off. Off empties the ring: a trace belongs to the
    /// Dev Mode session that recorded it.
    pub fn set_mode(&self, mode: TraceMode) {
        let mut ring = self.lock();
        ring.mode = if mode.enabled {
            mode
        } else {
            TraceMode::default()
        };
        if !mode.enabled {
            ring.entries.clear();
            ring.open.clear();
        }
    }

    /// Record `frame` if recording is on, returning the entry to publish.
    pub fn record(&self, frame: TraceFrame<'_>) -> Option<TraceEntry> {
        let mut ring = self.lock();
        if !ring.mode.enabled {
            return None;
        }
        ring.next_seq += 1;
        let mut method = frame.method.map(str::to_string);
        let mut duration_ms = frame.duration_ms;
        if let Some(id) = frame.id.clone() {
            match frame.kind {
                TraceKind::Request => {
                    if ring.open.len() >= TRACE_CAPACITY {
                        ring.open.clear();
                    }
                    let key = (
                        frame.root.to_string(),
                        frame.generation,
                        id,
                        frame.direction,
                    );
                    ring.open.insert(key, (method.clone(), Instant::now()));
                }
                TraceKind::Response => {
                    let asked = match frame.direction {
                        TraceDirection::Inbound => TraceDirection::Outbound,
                        TraceDirection::Outbound => TraceDirection::Inbound,
                    };
                    let key = (frame.root.to_string(), frame.generation, id, asked);
                    if let Some((asked_method, started)) = ring.open.remove(&key) {
                        method = method.or(asked_method);
                        duration_ms = duration_ms.or(Some(started.elapsed().as_millis() as u64));
                    }
                }
                TraceKind::Notification | TraceKind::Event => {}
            }
        }
        let plugin_id = frame
            .payload
            .and_then(|payload| payload.get("pluginId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let payload = frame.payload.map(|payload| {
            if ring.mode.include_payloads {
                payload.clone()
            } else {
                shape(payload, SHAPE_DEPTH)
            }
        });
        let entry = TraceEntry {
            seq: ring.next_seq,
            at_ms: now_ms(),
            root: frame.root.to_string(),
            generation: frame.generation,
            direction: frame.direction,
            kind: frame.kind,
            method,
            id: frame.id,
            plugin_id,
            bytes: frame.bytes,
            duration_ms,
            error_code: frame.error_code,
            payload,
        };
        if ring.entries.len() == TRACE_CAPACITY {
            ring.entries.pop_front();
        }
        ring.entries.push_back(entry.clone());
        Some(entry)
    }

    /// Entries after `since` (all when `None`), optionally for one root.
    pub fn entries(&self, since: Option<u64>, root: Option<&str>) -> Vec<TraceEntry> {
        self.lock()
            .entries
            .iter()
            .filter(|entry| since.is_none_or(|since| entry.seq > since))
            .filter(|entry| root.is_none_or(|root| entry.root == root))
            .cloned()
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Ring> {
        self.ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A value's shape: keys and lengths kept, every leaf replaced by its type.
pub fn shape(value: &Value, depth: usize) -> Value {
    match value {
        Value::Null => Value::String("null".into()),
        Value::Bool(_) => Value::String("boolean".into()),
        Value::Number(_) => Value::String("number".into()),
        Value::String(text) => Value::String(format!("string({})", text.chars().count())),
        Value::Array(items) if depth == 0 => Value::String(format!("array({})", items.len())),
        Value::Object(map) if depth == 0 => Value::String(format!("object({})", map.len())),
        Value::Array(items) => {
            let mut shaped: Vec<Value> = items
                .iter()
                .take(3)
                .map(|item| shape(item, depth - 1))
                .collect();
            if items.len() > 3 {
                shaped.push(Value::String(format!("…{} more", items.len() - 3)));
            }
            Value::Array(shaped)
        }
        Value::Object(map) => {
            let mut shaped = Map::new();
            for (key, entry) in map.iter().take(SHAPE_KEYS) {
                shaped.insert(key.clone(), shape(entry, depth - 1));
            }
            if map.len() > SHAPE_KEYS {
                shaped.insert(
                    "…".into(),
                    Value::String(format!("{} more keys", map.len() - SHAPE_KEYS)),
                );
            }
            Value::Object(shaped)
        }
    }
}

/// A JSON-RPC id as trace text: numbers and strings alike.
pub fn id_text(id: &Value) -> Option<String> {
    match id {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame<'a>(root: &'a str, payload: Option<&'a Value>) -> TraceFrame<'a> {
        TraceFrame {
            root,
            generation: 3,
            direction: TraceDirection::Inbound,
            kind: TraceKind::Request,
            method: Some("cognia/provider/invoke"),
            id: Some("proxy:1".into()),
            bytes: 42,
            duration_ms: None,
            error_code: None,
            payload,
        }
    }

    #[test]
    fn off_records_nothing() {
        let trace = BrokerTrace::default();
        assert!(trace.record(frame("/w", None)).is_none());
        assert!(trace.entries(None, None).is_empty());
    }

    #[test]
    fn on_keeps_only_the_payload_shape_unless_values_were_asked_for() {
        let trace = BrokerTrace::default();
        trace.set_mode(TraceMode {
            enabled: true,
            include_payloads: false,
        });
        let payload = json!({ "path": "/home/me/secret.txt", "line": 4, "flags": [true, false], "pluginId": "acme" });
        let entry = trace.record(frame("/w", Some(&payload))).unwrap();
        assert_eq!(entry.plugin_id.as_deref(), Some("acme"));
        assert_eq!(
            entry.payload,
            Some(json!({
                "path": "string(19)",
                "line": "number",
                "flags": ["boolean", "boolean"],
                "pluginId": "string(4)"
            }))
        );
        assert_eq!(entry.seq, 1);
        assert_eq!(entry.method.as_deref(), Some("cognia/provider/invoke"));

        trace.set_mode(TraceMode {
            enabled: true,
            include_payloads: true,
        });
        let entry = trace.record(frame("/w", Some(&payload))).unwrap();
        assert_eq!(entry.payload, Some(payload));
    }

    #[test]
    fn the_ring_is_bounded_and_resumable_by_seq_and_root() {
        let trace = BrokerTrace::default();
        trace.set_mode(TraceMode {
            enabled: true,
            include_payloads: false,
        });
        for index in 0..TRACE_CAPACITY + 5 {
            let root = if index % 2 == 0 { "/a" } else { "/b" };
            trace.record(frame(root, None));
        }
        let all = trace.entries(None, None);
        assert_eq!(all.len(), TRACE_CAPACITY);
        assert_eq!(all.first().unwrap().seq, 6);
        let last = all.last().unwrap().seq;
        assert!(trace.entries(Some(last), None).is_empty());
        assert_eq!(trace.entries(Some(last - 2), None).len(), 2);
        assert!(trace
            .entries(None, Some("/a"))
            .iter()
            .all(|entry| entry.root == "/a"));
    }

    #[test]
    fn a_response_is_labelled_with_the_method_and_round_trip_of_its_request() {
        let trace = BrokerTrace::default();
        trace.set_mode(TraceMode {
            enabled: true,
            include_payloads: false,
        });
        trace.record(TraceFrame {
            direction: TraceDirection::Outbound,
            method: Some("openFile"),
            id: Some("9".into()),
            ..frame("/w", None)
        });
        let answer = trace
            .record(TraceFrame {
                direction: TraceDirection::Inbound,
                kind: TraceKind::Response,
                method: None,
                id: Some("9".into()),
                error_code: Some(-32603),
                ..frame("/w", None)
            })
            .unwrap();
        assert_eq!(answer.method.as_deref(), Some("openFile"));
        assert!(answer.duration_ms.is_some());
        assert_eq!(answer.error_code, Some(-32603));
        // The same id on another generation is a different request.
        let stray = trace
            .record(TraceFrame {
                generation: 4,
                direction: TraceDirection::Inbound,
                kind: TraceKind::Response,
                method: None,
                id: Some("9".into()),
                ..frame("/w", None)
            })
            .unwrap();
        assert_eq!(stray.method, None);
        assert_eq!(stray.duration_ms, None);
    }

    #[test]
    fn turning_it_off_forgets_the_session_and_its_payload_opt_in() {
        let trace = BrokerTrace::default();
        trace.set_mode(TraceMode {
            enabled: true,
            include_payloads: true,
        });
        trace.record(frame("/w", None));
        trace.set_mode(TraceMode {
            enabled: false,
            include_payloads: true,
        });
        assert!(trace.entries(None, None).is_empty());
        assert_eq!(trace.mode(), TraceMode::default());
    }

    #[test]
    fn shapes_are_bounded_in_depth_width_and_length() {
        let deep = json!({ "a": { "b": { "c": [1, 2, 3, 4, 5] } } });
        assert_eq!(shape(&deep, 2), json!({ "a": { "b": "object(1)" } }));
        assert_eq!(
            shape(&json!([1, 2, 3, 4, 5]), 3),
            json!(["number", "number", "number", "…2 more"])
        );
        let wide: Map<String, Value> = (0..40)
            .map(|index| (format!("k{index:02}"), json!(index)))
            .collect();
        let shaped = shape(&Value::Object(wide), 3);
        assert_eq!(shaped.as_object().unwrap().len(), SHAPE_KEYS + 1);
        assert_eq!(shaped["…"], json!("8 more keys"));
        assert_eq!(id_text(&json!(7)).as_deref(), Some("7"));
        assert_eq!(id_text(&json!("proxy:2")).as_deref(), Some("proxy:2"));
        assert_eq!(id_text(&Value::Null), None);
    }
}
