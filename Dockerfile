# AgentForge en un contenedor, para uso local.
#
# AVISO: la imagen NO se ha construido ni ejecutado con Docker (el motor estaba apagado en el equipo de
# desarrollo). Sus dos primeras etapas se han reproducido a mano fuera de Docker (misma selección de archivos,
# `npm ci`, `npm run build` y arranque con las dependencias de ejecución), en Windows y no en Alpine.
# Compruébalo antes de fiarte de él:  docker build -t agentforge .
#
# Uso (la clave de acceso es obligatoria porque el servidor escucha fuera de 127.0.0.1):
#   docker run --rm -p 127.0.0.1:4310:4310 -v agentforge-data:/data --stop-timeout 20 \
#     -e AGENTFORGE_TOKEN=una-clave-de-16-caracteres-o-mas \
#     -e OLLAMA_URL=http://host.docker.internal:11434 \
#     agentforge
# - En Linux añade  --add-host=host.docker.internal:host-gateway  para llegar al Ollama del equipo.
# - Para entrar desde otro equipo publica el puerto sin 127.0.0.1 y declara el nombre o la IP por la que se llega
#   con  -e AGENTFORGE_ALLOWED_HOSTS=192.168.1.5  (si no, el servidor responde 403 «Host no permitido»).
# - Si montas una carpeta del equipo en lugar de un volumen, debe poder escribirla el usuario del contenedor:
#   --user "$(id -u):$(id -g)"  o  chown 1000:1000 sobre la carpeta.

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
# La sonda no necesita la clave de acceso y usa el puerto configurado (PORT).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/api/health/live').then(r=>{process.exitCode=r.ok?0:1},()=>{process.exitCode=1})"
# `docker stop` envía SIGTERM: el servidor hace un apagado ordenado y deja las ejecuciones reanudables. El apagado
# espera hasta 10 s a las ejecuciones y luego cierra la base de datos: dale margen con  --stop-timeout 20.
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "server/src/index.ts"]
