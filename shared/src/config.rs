use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Settings {
    pub database_url: String,
    pub message_broker_url: String,
}

impl Settings {
    pub fn new() -> Result<Self, config::ConfigError> {
        let mut cfg = config::Config::default();
        cfg.merge(config::Environment::default())?;
        cfg.try_into()
    }
}
