# AgentForge en un contenedor, para uso local.
#
# AVISO: este archivo NO se ha construido ni ejecutado (el motor de Docker estaba apagado en el equipo de
# desarrollo). Refleja los mismos pasos que se usan fuera del contenedor (`npm ci`, `npm run build`, `npm start`).
# Compruébalo antes de fiarte de él:  docker build -t agentforge .
#
# Uso (la clave de acceso es obligatoria porque el servidor escucha fuera de 127.0.0.1):
#   docker run --rm -p 4310:4310 -v agentforge-data:/data \
#     -e AGENTFORGE_TOKEN=una-clave-de-16-caracteres-o-mas \
#     -e OLLAMA_URL=http://host.docker.internal:11434 \
#     agentforge
# En Linux añade  --add-host=host.docker.internal:host-gateway  para llegar al Ollama del equipo.

# ---------- 1) Compilación de la interfaz ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts
COPY shared shared
COPY web web
RUN npm run build

# ---------- 2) Dependencias de ejecución (sin las de desarrollo) ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace server --include-workspace-root

# ---------- 3) Imagen final ----------
FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    AGENTFORGE_DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY server/package.json server/package.json
COPY server/src server/src
COPY shared shared
COPY --from=build /app/web/dist web/dist
# Los datos (base de datos, clave de cifrado, espacio de trabajo y copias) viven en un volumen.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4310
# La sonda no necesita la clave de acceso.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4310/api/health/live >/dev/null || exit 1
# `docker stop` envía SIGTERM: el servidor hace un apagado ordenado y deja las ejecuciones reanudables.
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "server/src/index.ts"]
