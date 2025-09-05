ARG REGISTRY_MIRROR=docker.adesso.claims/library

FROM ${REGISTRY_MIRROR}/postgres:16
WORKDIR /migrations
COPY migrations/*.sql /migrations/
COPY migrations/run.sh /run.sh
RUN chmod +x /run.sh
# DATABASE_URL kommt zur Laufzeit aus Portainer / compose
ENV DATABASE_URL=""
ENTRYPOINT ["/bin/sh", "/run.sh"]
