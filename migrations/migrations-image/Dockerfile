# syntax=docker/dockerfile:1
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /migrations
COPY ../migrations/*.sql /migrations/
COPY ./run.sh /run.sh
RUN chmod +x /run.sh

ENV DATABASE_URL=""
USER 65532:65532
ENTRYPOINT ["/bin/sh", "/run.sh"]
