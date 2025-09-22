SET search_path TO public;

CREATE TABLE IF NOT EXISTS group_prompts (
                                             group_id  INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE,
    prompt_id INTEGER NOT NULL REFERENCES prompts(id)        ON DELETE CASCADE,
    PRIMARY KEY (group_id, prompt_id)
    );
