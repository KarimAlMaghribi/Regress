//! Provides a lightweight error type shared across services so callers can
//! consistently bubble IO and database issues up the stack without pulling in
//! heavy dependencies.

use thiserror::Error;

/// Service wide error variants that map the most common failure categories.
#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(String),
    #[error("IO error: {0}")]
    Io(String),
}

/// Shortcut alias to reuse [`AppError`] with the standard [`Result`] pattern.
pub type Result<T> = std::result::Result<T, AppError>;
