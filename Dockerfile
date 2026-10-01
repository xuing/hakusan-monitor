# ---- stage 1: build the React app ----
FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm install --global npm@12.0.1 \
 && npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: python runtime (stdlib only + ssh client) ----
FROM python:3.14-slim@sha256:caaf356f40667c496d405780745b9ac25771c189a51dfcc42430d531ea09f8a2
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
