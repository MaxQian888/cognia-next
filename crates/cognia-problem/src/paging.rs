//! Page tokens and page envelopes (ADR-0175 B3, after AIP-158).
//!
//! A paging command takes `pageSize` and `pageToken` and answers
//! `{items, nextPageToken}`. The token is opaque to the caller and encodes
//! whatever the arm pages by underneath: an offset into a counted store, or
//! the cursor a backend hands back. `offset` and `length` are reserved for byte
//! I/O on `read` and `write` verbs and are refused here, as are the four
//! spellings this surface used to take (`limit`, `offset`, `cursor`, `before`),
//! so a caller on the old shape learns it in one named error instead of
//! silently getting the first page.
//!
//! This module is self-contained on `serde_json::Value` so the companion
//! dispatch arms, the desktop IPC commands, and the leaf crates that implement
//! them can share it. Errors are `PagingError`, which each surface maps onto
//! its own refusal type.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The page size used when the caller names none.
pub const DEFAULT_PAGE_SIZE: u32 = 50;
/// The largest page any command answers.
pub const MAX_PAGE_SIZE: u32 = 1_000;

/// The spellings this surface used to page by. Refused on a paging command so
/// the old shape fails loudly instead of being ignored.
pub const LEGACY_PAGING_PARAMETERS: &[&str] = &["limit", "offset", "cursor", "before"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PagingError {
    #[error("pageSize must be an integer between 1 and {MAX_PAGE_SIZE}")]
    PageSize,
    #[error("pageToken is not a token this host issued")]
    PageToken,
    #[error("{0} is not a paging parameter here. Use pageSize and pageToken")]
    LegacyParameter(&'static str),
}

/// What a page token stands for. Never shown to a caller unencoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageToken {
    /// The next row of a counted store.
    Offset(u64),
    /// The cursor a backend handed back for its next page.
    Cursor(String),
}

impl PageToken {
    pub fn encode(&self) -> String {
        let plain = match self {
            Self::Offset(offset) => format!("o:{offset}"),
            Self::Cursor(cursor) => format!("c:{cursor}"),
        };
        URL_SAFE_NO_PAD.encode(plain)
    }

    pub fn decode(raw: &str) -> Result<Self, PagingError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| PagingError::PageToken)?;
        let plain = String::from_utf8(bytes).map_err(|_| PagingError::PageToken)?;
        if let Some(offset) = plain.strip_prefix("o:") {
            return offset
                .parse::<u64>()
                .map(Self::Offset)
                .map_err(|_| PagingError::PageToken);
        }
        if let Some(cursor) = plain.strip_prefix("c:") {
            if cursor.is_empty() {
                return Err(PagingError::PageToken);
            }
            return Ok(Self::Cursor(cursor.to_string()));
        }
        Err(PagingError::PageToken)
    }
}

/// The paging half of a request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageRequest {
    pub page_size: Option<u32>,
    pub page_token: Option<PageToken>,
}

impl PageRequest {
    /// Read `pageSize` and `pageToken` from a command's arguments. Refuses the
    /// legacy spellings so a caller on the old shape gets one named answer.
    pub fn from_args(args: &Value) -> Result<Self, PagingError> {
        let object = args.as_object();
        for legacy in LEGACY_PAGING_PARAMETERS {
            if object.is_some_and(|map| map.contains_key(*legacy)) {
                return Err(PagingError::LegacyParameter(legacy));
            }
        }
        let page_size = match object.and_then(|map| map.get("pageSize")) {
            None | Some(Value::Null) => None,
            Some(value) => {
                let size = value
                    .as_u64()
                    .filter(|size| (1..=u64::from(MAX_PAGE_SIZE)).contains(size))
                    .ok_or(PagingError::PageSize)?;
                Some(size as u32)
            }
        };
        let page_token = match object.and_then(|map| map.get("pageToken")) {
            None | Some(Value::Null) => None,
            Some(Value::String(raw)) if raw.is_empty() => None,
            Some(Value::String(raw)) => Some(PageToken::decode(raw)?),
            Some(_) => return Err(PagingError::PageToken),
        };
        Ok(Self {
            page_size,
            page_token,
        })
    }

    /// The desktop IPC spelling: the two parameters as the command received
    /// them.
    pub fn from_parts(
        page_size: Option<u32>,
        page_token: Option<&str>,
    ) -> Result<Self, PagingError> {
        let mut args = Map::new();
        if let Some(size) = page_size {
            args.insert("pageSize".to_string(), Value::from(size));
        }
        if let Some(token) = page_token {
            args.insert("pageToken".to_string(), Value::from(token));
        }
        Self::from_args(&Value::Object(args))
    }

    pub fn page_size_or(&self, default: u32) -> u32 {
        self.page_size.unwrap_or(default).clamp(1, MAX_PAGE_SIZE)
    }

    /// The offset an offset-paged arm starts at. A cursor token on an
    /// offset-paged command was issued by another command, so it is refused.
    pub fn offset(&self) -> Result<u64, PagingError> {
        match &self.page_token {
            None => Ok(0),
            Some(PageToken::Offset(offset)) => Ok(*offset),
            Some(PageToken::Cursor(_)) => Err(PagingError::PageToken),
        }
    }

    /// The backend cursor a cursor-paged arm continues from.
    pub fn cursor(&self) -> Result<Option<String>, PagingError> {
        match &self.page_token {
            None => Ok(None),
            Some(PageToken::Cursor(cursor)) => Ok(Some(cursor.clone())),
            Some(PageToken::Offset(_)) => Err(PagingError::PageToken),
        }
    }
}

/// One page of a collection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    /// Present exactly when another page exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_page_token: Option<String>,
}

impl<T> Page<T> {
    /// A page from a counted store: the caller fetched `items` starting at
    /// `offset`, and `more` says whether rows remain after them.
    pub fn from_offset(items: Vec<T>, offset: u64, more: bool) -> Self {
        let next_page_token = more.then(|| PageToken::Offset(offset + items.len() as u64).encode());
        Self {
            items,
            next_page_token,
        }
    }

    /// A page from a cursor-paged backend.
    pub fn from_cursor(items: Vec<T>, next_cursor: Option<String>) -> Self {
        let next_page_token = next_cursor
            .filter(|cursor| !cursor.is_empty())
            .map(|cursor| PageToken::Cursor(cursor).encode());
        Self {
            items,
            next_page_token,
        }
    }

    /// Page an in-memory collection. This is how a bounded list that a
    /// backend returns whole answers the paging shape without changing the
    /// backend.
    pub fn slice_all(
        all: Vec<T>,
        request: &PageRequest,
        default_page_size: u32,
    ) -> Result<Self, PagingError> {
        let offset = request.offset()?;
        let page_size = request.page_size_or(default_page_size) as usize;
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(all.len());
        let end = start.saturating_add(page_size).min(all.len());
        let more = end < all.len();
        let items: Vec<T> = all.into_iter().skip(start).take(end - start).collect();
        Ok(Self::from_offset(items, offset, more))
    }

    pub fn map<U>(self, f: impl FnMut(T) -> U) -> Page<U> {
        Page {
            items: self.items.into_iter().map(f).collect(),
            next_page_token: self.next_page_token,
        }
    }
}

impl Page<Value> {
    /// A page from a legacy offset page the bridge or the direct store still
    /// answers (`{rows, total?, next_offset?, nextOffset?, has_more?}`), plus
    /// whatever extra top-level members the caller wants to keep (`total`).
    pub fn from_legacy_offset_page(
        legacy: Value,
        rows_key: &str,
        offset: u64,
        keep: &[&str],
    ) -> (Self, Map<String, Value>) {
        let mut object = match legacy {
            Value::Object(map) => map,
            other => {
                let items = match other {
                    Value::Array(items) => items,
                    _ => Vec::new(),
                };
                return (Self::from_offset(items, offset, false), Map::new());
            }
        };
        let items = match object.remove(rows_key) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        let has_more = object.get("has_more").and_then(Value::as_bool);
        let next_offset = object
            .get("next_offset")
            .or_else(|| object.get("nextOffset"))
            .and_then(Value::as_u64);
        let more = has_more.unwrap_or(next_offset.is_some());
        let page = match next_offset {
            Some(next) if more => Self {
                items,
                next_page_token: Some(PageToken::Offset(next).encode()),
            },
            _ => Self::from_offset(items, offset, more),
        };
        let extras = keep
            .iter()
            .filter_map(|key| object.remove(*key).map(|value| ((*key).to_string(), value)))
            .collect();
        (page, extras)
    }

    /// A page from a legacy cursor page a backend still answers
    /// (`{<rows>, <nextCursor>, <hasMore>, ...}`), keeping the extra members
    /// the caller names.
    pub fn from_legacy_cursor_page(
        legacy: Value,
        rows_key: &str,
        next_cursor_key: &str,
        has_more_key: &str,
        keep: &[&str],
    ) -> (Self, Map<String, Value>) {
        let mut object = match legacy {
            Value::Object(map) => map,
            Value::Array(items) => return (Self::from_cursor(items, None), Map::new()),
            _ => return (Self::from_cursor(Vec::new(), None), Map::new()),
        };
        let items = match object.remove(rows_key) {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        let has_more = object.remove(has_more_key).and_then(|v| v.as_bool());
        let next_cursor = object
            .remove(next_cursor_key)
            .and_then(|value| match value {
                Value::String(cursor) => Some(cursor),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            });
        let page = match has_more {
            Some(false) => Self::from_cursor(items, None),
            _ => Self::from_cursor(items, next_cursor),
        };
        let extras = keep
            .iter()
            .filter_map(|key| object.remove(*key).map(|value| ((*key).to_string(), value)))
            .collect();
        (page, extras)
    }

    /// The wire document with extra top-level members (`total`,
    /// `capabilityRevision`, and the like) beside `items`.
    pub fn into_value_with(self, extras: Map<String, Value>) -> Value {
        let mut object = match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        for (key, value) in extras {
            object.entry(key).or_insert(value);
        }
        Value::Object(object)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tokens_round_trip_and_reject_what_the_host_did_not_issue() {
        for token in [
            PageToken::Offset(0),
            PageToken::Offset(u64::MAX),
            PageToken::Cursor("evt-42".into()),
        ] {
            assert_eq!(PageToken::decode(&token.encode()), Ok(token));
        }
        for raw in [
            "",
            "o:12",
            "!!!",
            &URL_SAFE_NO_PAD.encode("x:1"),
            &URL_SAFE_NO_PAD.encode("o:-1"),
            &URL_SAFE_NO_PAD.encode("c:"),
        ] {
            assert_eq!(
                PageToken::decode(raw),
                Err(PagingError::PageToken),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn request_reads_the_two_parameters_and_refuses_the_old_four() {
        let request = PageRequest::from_args(&json!({
            "pageSize": 25,
            "pageToken": PageToken::Offset(50).encode(),
        }))
        .unwrap();
        assert_eq!(request.page_size, Some(25));
        assert_eq!(request.offset(), Ok(50));
        assert_eq!(request.cursor(), Err(PagingError::PageToken));
        assert_eq!(
            PageRequest::from_parts(Some(25), Some(&PageToken::Offset(50).encode())),
            Ok(request)
        );

        assert_eq!(
            PageRequest::from_args(&json!({})).unwrap(),
            PageRequest::default()
        );
        assert_eq!(
            PageRequest::from_args(&json!({ "pageToken": "" })).unwrap(),
            PageRequest::default()
        );
        assert_eq!(
            PageRequest::from_args(&json!(null)).unwrap(),
            PageRequest::default()
        );

        for legacy in ["limit", "offset", "cursor", "before"] {
            assert_eq!(
                PageRequest::from_args(&json!({ legacy: 5 })),
                Err(PagingError::LegacyParameter(
                    LEGACY_PAGING_PARAMETERS
                        .iter()
                        .copied()
                        .find(|name| *name == legacy)
                        .unwrap()
                ))
            );
        }
        for size in [json!(0), json!(-1), json!(1001), json!("10"), json!(2.5)] {
            assert_eq!(
                PageRequest::from_args(&json!({ "pageSize": size })),
                Err(PagingError::PageSize),
                "{size}"
            );
        }
        assert_eq!(
            PageRequest::from_args(&json!({ "pageToken": 7 })),
            Err(PagingError::PageToken)
        );
        assert_eq!(
            PageRequest {
                page_size: Some(5_000),
                page_token: None
            }
            .page_size_or(10),
            MAX_PAGE_SIZE
        );
        assert_eq!(PageRequest::default().page_size_or(10), 10);
    }

    #[test]
    fn offset_pages_carry_a_token_exactly_when_more_remains() {
        let page = Page::from_offset(vec![1, 2, 3], 10, true);
        assert_eq!(
            page.next_page_token.as_deref().map(PageToken::decode),
            Some(Ok(PageToken::Offset(13)))
        );
        let last = Page::from_offset(vec![1], 13, false);
        assert_eq!(last.next_page_token, None);
        assert_eq!(
            serde_json::to_value(&last).unwrap(),
            json!({ "items": [1] }),
            "no token member on the last page"
        );
        let cursor = Page::from_cursor(vec!["a"], Some("next".into()));
        assert_eq!(
            cursor.next_page_token.as_deref().map(PageToken::decode),
            Some(Ok(PageToken::Cursor("next".into())))
        );
        assert_eq!(
            Page::from_cursor(vec!["a"], Some(String::new())).next_page_token,
            None
        );
    }

    #[test]
    fn slicing_a_whole_collection_walks_it_to_the_end() {
        let all: Vec<u32> = (0..7).collect();
        let mut request = PageRequest {
            page_size: Some(3),
            page_token: None,
        };
        let mut seen = Vec::new();
        loop {
            let page = Page::slice_all(all.clone(), &request, 50).unwrap();
            seen.extend(page.items.iter().copied());
            match page.next_page_token {
                Some(token) => request.page_token = Some(PageToken::decode(&token).unwrap()),
                None => break,
            }
        }
        assert_eq!(seen, all);
        // Past the end is an empty last page, not an error.
        let past = PageRequest {
            page_size: Some(3),
            page_token: Some(PageToken::Offset(99)),
        };
        let page = Page::slice_all(all, &past, 50).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.next_page_token, None);
    }

    #[test]
    fn legacy_cursor_pages_become_pages_and_stop_when_the_backend_says_so() {
        let (page, extras) = Page::from_legacy_cursor_page(
            json!({ "messages": [1], "nextCursor": "m-9", "hasMore": true, "revision": 3 }),
            "messages",
            "nextCursor",
            "hasMore",
            &["revision"],
        );
        assert_eq!(
            page.next_page_token.as_deref().map(PageToken::decode),
            Some(Ok(PageToken::Cursor("m-9".into())))
        );
        assert_eq!(extras.get("revision"), Some(&json!(3)));
        // A cursor with hasMore false is the end, whatever the cursor says.
        let (page, _) = Page::from_legacy_cursor_page(
            json!({ "messages": [1], "nextCursor": "m-9", "hasMore": false }),
            "messages",
            "nextCursor",
            "hasMore",
            &[],
        );
        assert_eq!(page.next_page_token, None);
        // A numeric cursor is carried as text.
        let (page, _) = Page::from_legacy_cursor_page(
            json!({ "events": [], "nextSeq": 42 }),
            "events",
            "nextSeq",
            "hasMore",
            &[],
        );
        assert_eq!(
            page.next_page_token.as_deref().map(PageToken::decode),
            Some(Ok(PageToken::Cursor("42".into())))
        );
    }

    #[test]
    fn legacy_offset_pages_become_pages_and_keep_what_the_caller_asks_for() {
        let (page, extras) = Page::from_legacy_offset_page(
            json!({ "rows": [{"id": "a"}], "total": 9, "next_offset": 1, "has_more": true }),
            "rows",
            0,
            &["total"],
        );
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            page.next_page_token.as_deref().map(PageToken::decode),
            Some(Ok(PageToken::Offset(1)))
        );
        assert_eq!(extras.get("total"), Some(&json!(9)));
        let value = page.into_value_with(extras);
        assert_eq!(value["total"], 9);
        assert!(value.get("rows").is_none());

        // The direct store counts and answers nextOffset without has_more.
        let (page, _) =
            Page::from_legacy_offset_page(json!({ "rows": [1, 2], "total": 2 }), "rows", 0, &[]);
        assert_eq!(page.next_page_token, None);
        // A bare array is one whole page.
        let (page, extras) = Page::from_legacy_offset_page(json!([1, 2, 3]), "rows", 0, &["x"]);
        assert_eq!(page.items.len(), 3);
        assert!(extras.is_empty());
    }
}
