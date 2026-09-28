ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH

FROM --platform=$BUILDPLATFORM node:22-alpine AS web-build

WORKDIR /app/web

COPY web/package.json web/bun.lock ./
RUN npm install

COPY VERSION /app/VERSION
COPY web ./
RUN npx tsc --noEmit && NEXT_PUBLIC_APP_VERSION="$(cat /app/VERSION)" npm run build


FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS codex-register-build

WORKDIR /build

COPY codex_register/package.json codex_register/package-lock.json ./
RUN npm ci

COPY codex_register/src ./src
COPY codex_register/tsup.config.ts codex_register/tsconfig.json ./
RUN npm run build

FROM --platform=$TARGETPLATFORM node:22-bookworm-slim AS codex-register-runtime


FROM --platform=$TARGETPLATFORM python:3.13-slim AS app

ARG TARGETPLATFORM
ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

WORKDIR /app

RUN pip install --no-cache-dir uv

# Native editable documents and real rendered slide previews. No model code runs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress fonts-noto-cjk poppler-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY main.py ./
COPY admin ./admin
COPY config.example.json ./config.json
COPY VERSION ./
COPY services ./services
COPY utils ./utils
COPY --from=web-build /app/web/out ./web_dist
COPY --from=codex-register-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=codex-register-build /build/bundle ./codex_register/bundle
COPY --from=codex-register-build /build/node_modules/playwright-core ./codex_register/node_modules/playwright-core

EXPOSE 80

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "80", "--access-log"]
