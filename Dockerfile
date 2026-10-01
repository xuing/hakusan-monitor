# ---- stage 1: build the React app ----
FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm install --global npm@12.0.1 \
 && npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: python runtime (stdlib only + ssh client) ----
FROM python:3.14-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/ backend/
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
