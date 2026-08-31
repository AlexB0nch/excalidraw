FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS build

WORKDIR /opt/node_app

COPY . .

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

ARG NODE_ENV=production

# Self-hosting overrides. Vite inlines these into the bundle at build time, so
# they have to be passed as build args -- setting them on the running container
# has no effect. Leave any of them empty to keep the default from .env.production.
ARG VITE_APP_WS_SERVER_URL
ARG VITE_APP_BACKEND_V2_GET_URL
ARG VITE_APP_BACKEND_V2_POST_URL
ARG VITE_APP_FIREBASE_CONFIG
ARG VITE_APP_AI_BACKEND
ARG VITE_APP_LIBRARY_URL
ARG VITE_APP_LIBRARY_BACKEND
ARG VITE_APP_PLUS_LP
ARG VITE_APP_PLUS_APP
ARG VITE_APP_ENABLE_TRACKING

# Only the args that were actually provided are written out. `.env.production.local`
# has the highest precedence in vite, so these win over `.env.production`, while
# unset args leave the upstream defaults untouched.
RUN for name in \
      VITE_APP_WS_SERVER_URL \
      VITE_APP_BACKEND_V2_GET_URL \
      VITE_APP_BACKEND_V2_POST_URL \
      VITE_APP_FIREBASE_CONFIG \
      VITE_APP_AI_BACKEND \
      VITE_APP_LIBRARY_URL \
      VITE_APP_LIBRARY_BACKEND \
      VITE_APP_PLUS_LP \
      VITE_APP_PLUS_APP \
      VITE_APP_ENABLE_TRACKING \
    ; do \
      eval "value=\$$name"; \
      if [ -n "$value" ]; then \
        printf "%s='%s'\n" "$name" "$value" >> .env.production.local; \
      fi; \
    done; \
    if [ -f .env.production.local ]; then echo "build-time overrides:"; cat .env.production.local; fi

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

# `openssl passwd -apr1` hashes the basic-auth password at container start.
RUN apk add --no-cache openssl

COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/40-basic-auth.sh /docker-entrypoint.d/40-basic-auth.sh

# /healthz is served without auth on purpose -- see docker/nginx/default.conf.
HEALTHCHECK CMD wget -q -O /dev/null http://localhost/healthz || exit 1
