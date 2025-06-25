use serde::Deserialize;

fn default_database_url() -> String {
    "postgres://postgres:postgres@db:5432/regress".into()
}

fn default_message_broker_url() -> String {
    "kafka:9092".into()
}

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
    pub fn new() -> Result<Self, config::ConfigError> {
        config::Config::builder()
            .add_source(config::Environment::default())
            .build()?
            .try_deserialize()
    }
}
