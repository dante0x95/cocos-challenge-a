# Postgres 18 con un dump horneado en la imagen. Sin volúmenes: cada `up` parte del mismo estado.
#   DUMP=trading.dump  -> datos del challenge (fases 2–7)
#   DUMP=bench.dump    -> dataset del benchmark (fase 8+), ya migrado y con funciones
FROM postgres:18
ARG DUMP=trading.dump
COPY dump/${DUMP} /dumps/trading.dump
COPY docker/00-conf.sh    /docker-entrypoint-initdb.d/00-conf.sh
COPY docker/01-restore.sh /docker-entrypoint-initdb.d/01-restore.sh
COPY docker/02-grants.sh  /docker-entrypoint-initdb.d/02-grants.sh
COPY docker/03-vacuum.sh  /docker-entrypoint-initdb.d/03-vacuum.sh
# Los scripts pueden llegar con permisos 600 desde el host; el entrypoint corre como postgres.
RUN chmod 755 /docker-entrypoint-initdb.d/*.sh && chmod 644 /dumps/trading.dump
