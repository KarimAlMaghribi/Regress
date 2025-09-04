FROM postgres:16

WORKDIR /migrations

COPY ./*.sql /migrations/
COPY ./run.sh /run.sh

RUN sed -i 's/\r$//' /run.sh && chmod +x /run.sh

ENV DATABASE_URL=""

ENTRYPOINT ["/bin/sh", "/run.sh"]
