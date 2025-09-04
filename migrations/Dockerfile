FROM postgres:16
WORKDIR /migrations
COPY migrations/*.sql /migrations/
COPY migrations/run.sh /run.sh
RUN chmod +x /run.sh
ENV DATABASE_URL=""
ENTRYPOINT ["/bin/sh", "/run.sh"]
