SET search_path TO public;

CREATE TABLE IF NOT EXISTS prompt_groups (
                                             id       SERIAL PRIMARY KEY,
                                             name     TEXT NOT NULL UNIQUE,
                                             favorite BOOLEAN NOT NULL DEFAULT FALSE
);
