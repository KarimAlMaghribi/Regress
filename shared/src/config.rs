//! Loads process level configuration such as database connectivity and message
//! broker endpoints, providing sensible defaults for local development so that
//! services can start without additional environment setup.

use serde::Deserialize;

fn default_database_url() -> String {
    "postgres://regress:nITj%22%2B0%28f89F@localhost:5432/regress".into()
}

fn default_message_broker_url() -> String {
    "kafka:9092".into()
}

/// Application level settings populated from the environment.
#[derive(Debug, Deserialize)]
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
    /// Build a [`Settings`] instance by reading environment variables using the
    /// [`config`] crate, falling back to the defaults defined above.
    pub fn new() -> Result<Self, config::ConfigError> {
        config::Config::builder()
            .add_source(config::Environment::default())
            .build()?
            .try_deserialize()
    }
}
