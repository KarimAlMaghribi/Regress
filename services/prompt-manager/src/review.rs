use openai::chat::{ChatCompletionMessage, ChatCompletionMessageRole};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use shared::dto::PromptType;
use shared::openai_client::{self, PromptError};
use shared::openai_settings;

const SYSTEM_PROMPT: &str = r#"Du bist ein deutschsprachiger Senior Prompt Engineer für Schadenmanagementprozesse in der Versicherungsbranche.
Analysiere den gelieferten Prompt ausschließlich im Hinblick auf:
- fachliche Zielerreichung für den angegebenen Prompt-Typ,
- Konsistenz mit versicherungsfachlichen Richtlinien und Produktlogiken,
- Auswirkungen auf Schadenbearbeitung und Kundenerlebnis.

Ignoriere technische oder implementierungsbezogene Lücken (z. B. JSON-Strukturen, API-Parameter) und konzentriere dich ausschließlich auf fachliche Aspekte.

Antworte zwingend mit exakt einem JSON-Objekt und folgenden Feldern:
{
  "score": { "value": 0-100, "label": "excellent|good|fair|poor" },
  "strengths": [string],
  "issues": [ { "area": string, "severity": "low|medium|high", "detail": string } ],
  "guardrails": [string],
  "suggested_prompt": string,
  "notes": [string]
}

- "suggested_prompt" enthält einen vollständig überarbeiteten Prompt in der gleichen Sprache wie der Eingangstext.
- Stelle sicher, dass Stärken, Issues, Guardrails, Notes und der "suggested_prompt" ausschließlich fachliche Empfehlungen enthalten.
- Lasse keine Felder weg; verwende leere Arrays, wenn nichts gefunden wurde."#;

const EXTRACTION_TEMPLATE: &str = r#"PROMPT_TYP: ExtractionPrompt
JSON_KEY: {json_key}
ANFORDERUNG:
- Prüfe, ob der Prompt präzise beschreibt, welche fachlichen Informationen (z. B. Deckungsdetails, beteiligte Parteien, Schadenhöhe) extrahiert werden sollen.
- Bewerte, ob alle relevanten Versicherungskonzepte, Fristen oder Policenmerkmale berücksichtigt werden.
- Stelle sicher, dass der Prompt genau einen eindeutig benannten Wert verlangt (z. B. ein einzelnes JSON-Feld oder eine klar definierte Zeichenkette).
- Achte auf Robustheit gegen fehlende Angaben oder widersprüchliche Informationen in Schadenunterlagen.

PROMPT_TEXT:
<<<{prompt_text}>>>"#;

const SCORING_TEMPLATE: &str = r#"PROMPT_TYP: ScoringPrompt
GEWICHT: {weight}
ANFORDERUNG:
- Prüfe, ob der Prompt eine eindeutige Ja/Nein-Entscheidung inklusive Begründung verlangt.
- Stelle sicher, dass als finale Ausgabe ausschließlich "true" oder "false" akzeptiert werden.
- Überprüfe, ob die geforderten Begründungen auf relevante Vertrags- und Schadeninformationen Bezug nehmen.
- Bewerte, ob das Regelwerk konsistent mit den fachlichen Bewertungsrichtlinien und Gewichtungen im Schadenmanagement ist.

PROMPT_TEXT:
<<<{prompt_text}>>>"#;

const DECISION_TEMPLATE: &str = r#"PROMPT_TYP: DecisionPrompt
GEWICHT: {weight}
ANFORDERUNG:
- Prüfe, ob der Prompt klar definiert, welche fachlichen Eingaben (Scoring-Ergebnisse, Extraktionen) als Entscheidungsgrundlage dienen.
- Stelle sicher, dass Ausgabekategorien, Schwellenwerte oder Routing-Anweisungen fachlich sinnvoll und nachvollziehbar beschrieben werden.
- Stelle sicher, dass die finale Entscheidung ausschließlich als "true" oder "false" formuliert ist.
- Bewerte, ob Sonder- und Fehlerfälle (z. B. Kulanz, Betrugsverdacht, regulatorische Vorgaben) angemessen adressiert werden.

PROMPT_TEXT:
<<<{prompt_text}>>>"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewScore {
    pub value: u8,
    pub label: ReviewScoreLabel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewScoreLabel {
    Excellent,
    Good,
    Fair,
    Poor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewIssue {
    pub area: String,
    pub severity: ReviewIssueSeverity,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewIssueSeverity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptReview {
    pub score: ReviewScore,
    #[serde(default)]
    pub strengths: Vec<String>,
    #[serde(default)]
    pub issues: Vec<ReviewIssue>,
    #[serde(default)]
    pub guardrails: Vec<String>,
    #[serde(default)]
    pub suggested_prompt: String,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReviewError {
    #[error("failed to call OpenAI: {0}")]
    OpenAi(#[from] PromptError),
    #[error("failed to decode review payload: {0}")]
    Decode(#[from] serde_json::Error),
}

pub async fn evaluate_prompt(
    client: &Client,
    prompt_text: &str,
    prompt_type: PromptType,
    weight: Option<f64>,
    json_key: Option<&str>,
) -> Result<PromptReview, ReviewError> {
    let messages = build_messages(prompt_text, prompt_type, weight, json_key);
    let model = resolve_default_model();
    let raw = openai_client::call_openai_chat(client, &model, messages, None, None).await?;
    let review: PromptReview = serde_json::from_str(&raw)?;
    Ok(review)
}

fn build_messages(
    prompt_text: &str,
    prompt_type: PromptType,
    weight: Option<f64>,
    json_key: Option<&str>,
) -> Vec<ChatCompletionMessage> {
    let user = match prompt_type {
        PromptType::ExtractionPrompt => EXTRACTION_TEMPLATE
            .replace("{json_key}", json_key.unwrap_or("—"))
            .replace("{prompt_text}", prompt_text),
        PromptType::ScoringPrompt => SCORING_TEMPLATE
            .replace("{weight}", &format!("{:.2}", weight.unwrap_or(1.0)))
            .replace("{prompt_text}", prompt_text),
        PromptType::DecisionPrompt => DECISION_TEMPLATE
            .replace("{weight}", &format!("{:.2}", weight.unwrap_or(1.0)))
            .replace("{prompt_text}", prompt_text),
    };

    vec![
        ChatCompletionMessage {
            role: ChatCompletionMessageRole::System,
            content: Some(SYSTEM_PROMPT.to_string()),
            ..Default::default()
        },
        ChatCompletionMessage {
            role: ChatCompletionMessageRole::User,
            content: Some(user),
            ..Default::default()
        },
    ]
}

fn resolve_default_model() -> String {
    std::env::var("OPENAI_DEFAULT_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            openai_settings::model_for(openai_settings::DEFAULT_OPENAI_VERSION).to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extraction_prompt_injects_json_key() {
        let content = build_messages("Test", PromptType::ExtractionPrompt, None, Some("key"));
        let user = content.last().unwrap().content.clone().unwrap();
        assert!(user.contains("JSON_KEY: key"));
        assert!(user.contains("<<<Test>>>"));
    }
}
