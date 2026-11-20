# Watchdog EX alert state machine (alert engine).
#
# Same code as AlertDetection 1.1.16.0-30446 (svn trunk, unchanged since r30323).
# Unlike the build-server Dockerfile, this one installs the npm dependencies
# inside the image so the folder does not need a pre-populated node_modules.

FROM node:18-bookworm-slim

WORKDIR /app/WDEX/alertengine

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY alertStateMachine.js alertStateMachineServer.js ./
COPY utils ./utils

# Persisted alert rules and state maps. Mount a volume here (see docker-compose.yml).
RUN mkdir -p /app/WDEX/alertengine/data
VOLUME ["/app/WDEX/alertengine/data"]

EXPOSE 5000

# Args: <port> <inDocker>. "true" selects /app/WDEX/alertengine/data for persistence.
CMD ["node", "alertStateMachineServer.js", "5000", "true"]
