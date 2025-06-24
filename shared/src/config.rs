use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Settings {
    pub database_url: String,
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
