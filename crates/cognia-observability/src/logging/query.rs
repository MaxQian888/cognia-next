//! Compatibility adapter from the existing Tauri logging commands to the
//! runtime-neutral observability query contract shared with the CLI.

pub use crate::log_query::{
    list_log_dir, query_log_dir, NativeLogFileInfo, NativeLogQuery, NativeLogQueryResult,
};

use crate::logging::native_bootstrap;

/// Query the app's real log directory (companion API + Tauri command entry).
pub fn query_native_logs(query: &NativeLogQuery) -> Result<NativeLogQueryResult, String> {
    let dir = native_bootstrap::log_dir().ok_or_else(|| "log_directory_unavailable".to_string())?;
    query_log_dir(&dir, query)
}

/// List the app's real log directory (companion API + Tauri command entry).
pub fn list_native_log_files() -> Result<Vec<NativeLogFileInfo>, String> {
    let dir = native_bootstrap::log_dir().ok_or_else(|| "log_directory_unavailable".to_string())?;
    Ok(list_log_dir(&dir))
}

#[cfg(test)]
mod tests {
    use crate::log_query::{NativeLogFile, DEFAULT_LIMIT, MAX_LIMIT, MAX_SCAN_BYTES};

    #[test]
    fn compatibility_adapter_preserves_bounded_query_contract() {
        assert_eq!(DEFAULT_LIMIT, 200);
        assert_eq!(MAX_LIMIT, 1000);
        assert_eq!(MAX_SCAN_BYTES, 4 * 1024 * 1024);
        assert_eq!(NativeLogFile::default(), NativeLogFile::Structured);
    }
}
