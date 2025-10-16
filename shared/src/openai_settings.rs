#[derive(Debug, Clone, Copy)]
pub struct OpenAiVersionOption {
    pub key: &'static str,
    pub model: &'static str,
    pub endpoint: &'static str,
}

pub const OPENAI_VERSION_KEY: &str = "openai.version";

pub const OPENAI_VERSION_OPTIONS: &[OpenAiVersionOption] = &[
    OpenAiVersionOption {
        key: "gpt-4o",
        model: "gpt-4o",
        endpoint:
            "https://claims-manager.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview",
    },
    OpenAiVersionOption {
        key: "gpt-4o-mini",
        model: "gpt-4o-mini",
        endpoint:
            "https://claims-manager.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2025-01-01-preview",
    },
    OpenAiVersionOption {
        key: "gpt-5-mini",
        model: "gpt-5-mini",
        endpoint:
            "https://claims-manager.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2025-01-01-preview",
    },
    OpenAiVersionOption {
        key: "gpt-5-chat",
        model: "gpt-5-chat",
        endpoint:
            "https://claims-manager.openai.azure.com/openai/deployments/gpt-5-chat/chat/completions?api-version=2025-01-01-preview",
    },
    OpenAiVersionOption {
        key: "responses",
        model: "gpt-4o-mini",
        endpoint: "https://claims-manager.openai.azure.com/openai/responses?api-version=2025-04-01-preview",
    },
];

pub const DEFAULT_OPENAI_VERSION: &str = OPENAI_VERSION_OPTIONS[0].key;

pub fn is_valid_openai_version(key: &str) -> bool {
    OPENAI_VERSION_OPTIONS.iter().any(|opt| opt.key == key)
}

pub fn option_for(key: &str) -> &'static OpenAiVersionOption {
    OPENAI_VERSION_OPTIONS
        .iter()
        .find(|opt| opt.key == key)
        .unwrap_or(&OPENAI_VERSION_OPTIONS[0])
}

pub fn endpoint_for(key: &str) -> &'static str {
    option_for(key).endpoint
}

pub fn model_for(key: &str) -> &'static str {
    option_for(key).model
}
