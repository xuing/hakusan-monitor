# ---- stage 1: build the React app ----
FROM node:26-slim@sha256:45d1ae4f51c594ba87fdcf59370135c53a3845d96eb6009c2e36268c9b411644 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm install --global npm@12.2.0 \
 && npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: python runtime (stdlib only + ssh client) ----
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/ backend/
COPY sites/ sites/
COPY --from=web /web/dist web/dist

EXPOSE 8787
ENV HM_SOURCE=ssh \
    HM_PORT=8787 \
    HM_DB=/data/hakusan.sqlite \
    TZ=Asia/Tokyo
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=3)"]

# no pip install — the backend is pure standard library.
CMD ["python3", "backend/server.py"]
