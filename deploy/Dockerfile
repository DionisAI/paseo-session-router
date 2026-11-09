# Builds the Router from source, then runs it as the unprivileged node user. Configuration, credentials and data come from
# outside the image:
#   docker build -f deploy/Dockerfile -t paseo-session-router .
#   docker build -f deploy/Dockerfile --build-arg WITH_PASEO_SDK=true -t paseo-session-router .   (to connect real daemons)
#   docker run -p 127.0.0.1:8787:8787 --env-file .env -v "$PWD/router.json:/config/router.json:ro" -v psr-data:/data paseo-session-router
# Inside the container the Router must listen on 0.0.0.0: set "listen": "0.0.0.0" and "listenBeyondLoopback": true in the
# config, set "dataDir": "/data", and publish the port on 127.0.0.1 only (as above). See SECURITY.md.

FROM node:22.16.0-bookworm-slim AS build
WORKDIR /src
COPY tools/package.json tools/package-lock.json ./tools/
RUN npm ci --prefix tools
COPY package.json tsconfig.json ./
COPY scripts/build.mjs ./scripts/
COPY src ./src
COPY tests ./tests
RUN node scripts/build.mjs

FROM node:22.16.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /src/dist ./dist
COPY web ./web
COPY integrations ./integrations
COPY scripts ./scripts
# The Paseo SDK is optional (the demo and the core need no npm packages); install it on a build runner with network access.
ARG WITH_PASEO_SDK=false
RUN if [ "$WITH_PASEO_SDK" = "true" ]; then npm install --prefix integrations/paseo --omit=dev; fi
USER node
ENV PSR_CONFIG=/config/router.json
CMD ["node","--disable-warning=ExperimentalWarning","dist/src/main.js"]
# Daemons are reached through the Paseo relay (pairingEnv), so the container needs no SSH. A daemon reached by URL over an SSH
# tunnel with an identity probe needs SSH in the image: use the systemd deployment or extend the image explicitly.
