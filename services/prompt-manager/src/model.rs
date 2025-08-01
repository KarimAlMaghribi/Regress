use sea_orm::entity::prelude::*;

pub mod prompt {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "prompts")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub text: String,
        pub prompt_type: String,
        pub weight: f64,
        pub json_key: Option<String>,
        pub favorite: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

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

// Re-export commonly used types for convenience
pub use group::{ActiveModel as GroupActiveModel, Entity as GroupEntity, Model as GroupModel};
pub use group_prompt::{
    ActiveModel as GroupPromptActiveModel, Entity as GroupPromptEntity, Model as GroupPromptModel,
};
pub use prompt::{ActiveModel, Entity, Model};

pub mod pipeline {
    use super::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "pipelines")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub name: String,
        pub data: Json,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub use pipeline::{ActiveModel as PipelineActiveModel, Entity as PipelineEntity, Model as PipelineModel};
