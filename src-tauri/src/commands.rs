use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum AppError {
  #[error("name cannot be empty")]
  EmptyName,
}

#[tauri::command]
pub fn greet(name: &str) -> Result<String, AppError> {
  if name.trim().is_empty() {
    return Err(AppError::EmptyName);
  }
  Ok(format!("Hello, {name}! Welcome to Tauri 2."))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn greet_with_name() {
    assert_eq!(greet("World").unwrap(), "Hello, World! Welcome to Tauri 2.");
  }

  #[test]
  fn greet_empty_errors() {
    assert!(matches!(greet("").unwrap_err(), AppError::EmptyName));
  }

  #[test]
  fn greet_whitespace_errors() {
    assert!(matches!(greet("   ").unwrap_err(), AppError::EmptyName));
  }
}
