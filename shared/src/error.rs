//! Common error types shared across services.

use thiserror::Error;

#[derive(Error, Debug)]
/// Simplified error type wrapping the most common failure modes.
pub enum AppError {
    #[error("Database error: {0}")]
    Database(String),
    #[error("IO error: {0}")]
    Io(String),
}

/// Convenience alias for results that use [`AppError`].
pub type Result<T> = std::result::Result<T, AppError>;
