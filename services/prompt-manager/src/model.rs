//! SeaORM entity definitions for prompts, groups and pipelines.

use sea_orm::entity::prelude::*;

/* ---------- PROMPTS ---------- */

pub mod prompt {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "prompts")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub text: String,
        pub prompt_type: String,
        /// Optional weight used by scoring and decision prompts.
        pub weight: Option<Decimal>,
        pub json_key: Option<String>,
        pub favorite: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/* ---------- PROMPT GROUPS ---------- */

pub mod group {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "prompt_groups")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub name: String,
        pub favorite: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod group_prompt {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "group_prompts")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub group_id: i32,
        #[sea_orm(primary_key, auto_increment = false)]
        pub prompt_id: i32,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/* ---------- PIPELINES ---------- */

pub mod pipeline {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "pipelines")]
    pub struct Model {
        #[sea_orm(primary_key)]
        /// UUID matching pipeline identifiers in the API and database.
        pub id: Uuid,
        pub name: String,
        /// Stored pipeline configuration as JSON blob.
        pub config_json: Json,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/* ---------- Re-exports ---------- */

pub use group::{ActiveModel as GroupActiveModel, Entity as GroupEntity, Model as GroupModel};
pub use group_prompt::{
    ActiveModel as GroupPromptActiveModel, Entity as GroupPromptEntity, Model as GroupPromptModel,
};
pub use pipeline::{
    ActiveModel as PipelineActiveModel, Entity as PipelineEntity, Model as PipelineModel,
};
pub use prompt::{ActiveModel, Entity, Model};
