//! Configuration helpers shared across backend services.
//!
//! The configuration layer centralises access to environment variables so that
//! each service can rely on a consistent set of defaults when running locally
//! or in production.

use serde::Deserialize;

/// Provides the default PostgreSQL connection string used for local
/// development.
fn default_database_url() -> String {
    "postgres://regress:nITj%22%2B0%28f89F@localhost:5432/regress".into()
}

/// Provides the default Kafka bootstrap server URL.
fn default_message_broker_url() -> String {
    "kafka:9092".into()
}

#[derive(Debug, Deserialize)]
/// Top level configuration object constructed from environment variables.
pub struct Settings {
    #[serde(default = "default_database_url")]
    pub database_url: String,
    #[serde(default = "default_message_broker_url")]
    pub message_broker_url: String,
    #[serde(default)]
    pub openai_api_key: String,
    #[serde(default)]
    pub class_prompt_id: i32,
}

impl Settings {
    /// Loads settings from the process environment, falling back to defaults
    /// where individual values are not provided.
    pub fn new() -> Result<Self, config::ConfigError> {
        config::Config::builder()
            .add_source(config::Environment::default())
            .build()?
            .try_deserialize()
    }
}
