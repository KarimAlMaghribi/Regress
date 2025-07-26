use serde::Deserialize;

fn default_database_url() -> String {
    "postgres://regressdb%40regress-db-develop:cu5u.AVC%3F9055l@regress-db-develop.postgres.database.azure.com:5432/allianz?sslmode=require".into()
}

fn default_message_broker_url() -> String {
    "kafka:9092".into()
}

#[derive(Debug, Deserialize, Clone)]
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
