//! Keyset cursors for the two list commands, on the shared paging envelope
//! (`cognia_problem::paging`, ADR-0175 B3): a request carries `pageSize` and
//! an opaque `pageToken`, an answer `{ items, nextPageToken }`.
//!
//! The cursor is the last row's sort key, so a page never skips or repeats a
//! row when grants are created or audit rows written between two reads. It is
//! kind-tagged so a token from one list is refused by the other instead of
//! silently reading from the wrong position.

pub use cognia_problem::paging::{Page, PageRequest};
use cognia_problem::paging::PagingError;

use crate::error::{FileShareError, FileShareResult};

/// Default and largest grant page.
pub const GRANT_PAGE: (u32, u32) = (50, 200);
/// Default and largest audit page.
pub const AUDIT_PAGE: (u32, u32) = (100, 500);

/// The page size to use: the request's, clamped to `max`, else `default`.
pub fn size(request: &PageRequest, (default, max): (u32, u32)) -> u32 {
    request.page_size_or(default).min(max)
}

/// The grant list's cursor: the last grant's creation time and id.
pub fn grant_cursor(created_at: i64, id: &str) -> String {
    format!("g1:{created_at}:{id}")
}

pub fn parse_grant_cursor(request: &PageRequest) -> FileShareResult<Option<(i64, String)>> {
    let Some(cursor) = request.cursor().map_err(paging_error)? else {
        return Ok(None);
    };
    let parsed = cursor.strip_prefix("g1:").and_then(|rest| {
        let (created_at, id) = rest.split_once(':')?;
        let created_at = created_at.parse::<i64>().ok()?;
        (!id.is_empty()).then(|| (created_at, id.to_string()))
    });
    parsed.map(Some).ok_or_else(|| paging_error(PagingError::PageToken))
}

/// The audit list's cursor: the last row's id.
pub fn audit_cursor(id: i64) -> String {
    format!("a1:{id}")
}

pub fn parse_audit_cursor(request: &PageRequest) -> FileShareResult<Option<i64>> {
    let Some(cursor) = request.cursor().map_err(paging_error)? else {
        return Ok(None);
    };
    cursor
        .strip_prefix("a1:")
        .and_then(|id| id.parse::<i64>().ok())
        .map(Some)
        .ok_or_else(|| paging_error(PagingError::PageToken))
}

/// A paging refusal in this crate's vocabulary.
pub fn paging_error(error: PagingError) -> FileShareError {
    FileShareError::invalid(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_token(token: Option<String>) -> PageRequest {
        PageRequest::from_parts(Some(10), token.as_deref()).unwrap()
    }

    #[test]
    fn cursors_round_trip_and_refuse_each_other() {
        let grant = Page::<u8>::from_cursor(vec![], Some(grant_cursor(1_700_000_000_000, "fg_a:b")))
            .next_page_token;
        let audit = Page::<u8>::from_cursor(vec![], Some(audit_cursor(42))).next_page_token;
        assert_eq!(
            parse_grant_cursor(&with_token(grant.clone())).unwrap(),
            Some((1_700_000_000_000, "fg_a:b".to_string()))
        );
        assert_eq!(parse_audit_cursor(&with_token(audit.clone())).unwrap(), Some(42));
        assert_eq!(parse_grant_cursor(&with_token(audit)).unwrap_err().code, "invalid_request");
        assert_eq!(parse_audit_cursor(&with_token(grant)).unwrap_err().code, "invalid_request");
        assert_eq!(parse_grant_cursor(&with_token(None)).unwrap(), None);
    }

    #[test]
    fn sizes_are_clamped_and_defaulted() {
        let none = PageRequest::default();
        assert_eq!(size(&none, GRANT_PAGE), 50);
        assert_eq!(size(&PageRequest::from_parts(Some(1000), None).unwrap(), GRANT_PAGE), 200);
        assert_eq!(size(&PageRequest::from_parts(Some(7), None).unwrap(), AUDIT_PAGE), 7);
    }
}
