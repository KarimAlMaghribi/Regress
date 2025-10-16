//! Kafka administration helpers shared across services that need to ensure
//! topics are available before producing messages.

use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::error::{KafkaError, RDKafkaErrorCode};
use rdkafka::ClientConfig;
use tracing::{info, warn};

/// Ensure that the given Kafka topics exist.
///
/// Attempts to create each topic with a single partition and replication
/// factor 1. If the topic already exists the error is ignored.
pub async fn ensure_topics(broker: &str, topics: &[&str]) -> Result<(), KafkaError> {
    let admin: AdminClient<_> = ClientConfig::new()
        .set("bootstrap.servers", broker)
        .create()?;
    let new_topics: Vec<NewTopic> = topics
        .iter()
        .map(|t| NewTopic::new(t, 1, TopicReplication::Fixed(1)))
        .collect();
    let results = admin
        .create_topics(new_topics.iter(), &AdminOptions::new())
        .await?;
    for result in results {
        if let Err((name, err)) = result {
            if err != RDKafkaErrorCode::TopicAlreadyExists {
                warn!(topic = %name, %err, "failed to create topic");
            } else {
                info!(topic = %name, "topic already exists");
            }
        }
    }
    Ok(())
}
