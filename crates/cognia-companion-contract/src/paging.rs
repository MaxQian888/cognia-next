//! Page tokens and the page envelope (ADR-0175 B3). The types live in the
//! shared wire crate so the leaf crates that implement desktop commands can
//! answer the same shape. This module is the companion server's name for them.

pub use cognia_problem::paging::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_and_the_leaf_crates_share_one_page_vocabulary() {
        // The re-export is the whole module. Pin that the names the dispatch
        // arms use resolve here, so a rename in the wire crate is caught at
        // the server's own seam.
        assert_eq!(DEFAULT_PAGE_SIZE, 50);
        assert_eq!(MAX_PAGE_SIZE, 1000);
        let token = PageToken::Offset(20).encode();
        let request = PageRequest::from_parts(Some(10), Some(token.as_str())).unwrap();
        assert_eq!(request.page_size_or(DEFAULT_PAGE_SIZE), 10);
        assert_eq!(request.offset().unwrap(), 20);
        let page = Page::from_offset(vec![1, 2, 3], 20, true);
        assert_eq!(page.items, vec![1, 2, 3]);
        assert!(page.next_page_token.is_some());
    }
}
