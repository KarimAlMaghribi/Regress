FROM postgres:16
WORKDIR /migrations
COPY *.sql /migrations/
COPY run.sh /run.sh
ENV DATABASE_URL=""
ENTRYPOINT ["/bin/sh", "/run.sh"]
