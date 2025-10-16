//! Re-exports the shared utilities that are consumed by the microservices and
//! frontend tooling, allowing them to pull in configuration handling,
//! error types, database helpers, and the OpenAI client from a single crate.

pub mod config;
pub mod dto;
pub mod error;
pub mod openai_client;
pub mod utils;
pub mod kafka;
pub mod db;
