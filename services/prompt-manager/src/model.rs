use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "prompts")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub text: String,
    pub weight: f64,
    pub favorite: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "prompt_groups")]
pub struct GroupModel {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    pub favorite: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum GroupRelation {}

impl ActiveModelBehavior for GroupActiveModel {}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "group_prompts")]
pub struct GroupPromptModel {
    #[sea_orm(primary_key, auto_increment = false)]
    pub group_id: i32,
    #[sea_orm(primary_key, auto_increment = false)]
    pub prompt_id: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum GroupPromptRelation {}

impl ActiveModelBehavior for GroupPromptActiveModel {}
