workspace "Regress Architecture" "C4 model" {
    model {
        user = person "User" "End user" 

        regress = softwareSystem "Regress" "Distributed microservice system" {
            container_frontend = container "Frontend" "React application" "React"
            container_gateway = container "API Gateway" "Entry point" "Rust"
            container_pdf_ingest = container "PDF Ingest Service" "Handles uploads" "Rust"
            container_text_extraction = container "Text Extraction Service" "Performs OCR" "Rust"
            container_classifier = container "Classifier Service" "Classifies documents via OpenAI" "Rust" {
                component_controller = component "ClassificationController" "HTTP endpoints" "Rust"
                component_service = component "ClassificationService" "Business logic" "Rust"
                component_repository = component "ClassificationRepository" "Database access" "Rust"

                component_controller -> component_service "uses"
                component_service -> component_repository "uses"
                component_repository -> container_db "reads/writes"
            }
            container_prompt_manager = container "Prompt Manager" "Manages prompts" "Rust"
            container_pipeline_manager = container "Pipeline Manager" "Manages pipelines" "Rust"
            container_history = container "History Service" "WebSocket history" "Rust"
            container_metrics = container "Metrics Service" "Exports metrics" "Rust"
            container_db = container "PostgreSQL" "Stores data" "Database"
            container_kafka = container "Kafka" "Event bus" "Kafka"
        }

        user -> container_frontend "Uses"
        container_frontend -> container_gateway "HTTP"
        container_gateway -> container_pdf_ingest "Forwards requests"
        container_pdf_ingest -> container_text_extraction "Publishes event" "Kafka"
        container_text_extraction -> container_classifier "Publishes event" "Kafka"
        container_classifier -> container_db "JDBC"
        container_classifier -> container_prompt_manager "Reads prompts"
        container_prompt_manager -> container_db "JDBC"
        container_pdf_ingest -> container_db "JDBC"
        container_metrics -> container_db "JDBC"
        container_history -> container_db "JDBC"
        container_classifier -> container_kafka "Consumes"
        container_text_extraction -> container_kafka "Publishes"
        container_pdf_ingest -> container_kafka "Publishes"
    }

    views {
        systemContext regress "System Context" {
            include *
            autolayout lr
        }
        container regress "Containers" {
            include *
            autolayout lr
        }
        component container_classifier "Classifier Components" {
            include container_classifier/*
            autolayout lr
        }
    }

    styles {
        element "Database" {
            shape cylinder
        }
    }
}
