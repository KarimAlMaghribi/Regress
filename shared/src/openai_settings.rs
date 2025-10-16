//! Central registry for supported OpenAI deployments.

#[derive(Debug, Clone, Copy)]
/// Configuration describing a selectable OpenAI deployment.
pub struct OpenAiVersionOption {
    pub key: &'static str,
    pub model: &'static str,
    pub endpoint: &'static str,
}

/// Settings key used to store the preferred OpenAI version.
pub const OPENAI_VERSION_KEY: &str = "openai.version";

/// All supported OpenAI versions including their deployment metadata.
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

/// Default OpenAI version used when no preference is configured.
pub const DEFAULT_OPENAI_VERSION: &str = OPENAI_VERSION_OPTIONS[0].key;

/// Returns true when the provided key matches a supported version.
pub fn is_valid_openai_version(key: &str) -> bool {
    OPENAI_VERSION_OPTIONS.iter().any(|opt| opt.key == key)
}

/// Returns the [`OpenAiVersionOption`] for the given key or the default one.
pub fn option_for(key: &str) -> &'static OpenAiVersionOption {
    OPENAI_VERSION_OPTIONS
        .iter()
        .find(|opt| opt.key == key)
        .unwrap_or(&OPENAI_VERSION_OPTIONS[0])
}

/// Returns the endpoint URL for the provided version key.
pub fn endpoint_for(key: &str) -> &'static str {
    option_for(key).endpoint
}

/// Returns the model name for the provided version key.
pub fn model_for(key: &str) -> &'static str {
    option_for(key).model
}
