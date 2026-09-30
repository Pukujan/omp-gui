FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep openssh-client tzdata \
    && rm -rf /var/lib/apt/lists/*

# omp native binary (Linux x64) into /usr/local/bin; agent home /root/.omp (mount for auth)
ENV PI_INSTALL_DIR=/usr/local/bin
RUN curl -fsSL https://omp.sh/install | sh -s -- --binary && omp --version

WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev
COPY server/ server/
COPY web/ web/

ENV NODE_ENV=production \
    OMP_GUI_HOST=0.0.0.0 \
    OMP_GUI_PORT=8790 \
    OMP_BIN=/usr/local/bin/omp \
    OMP_GUI_DATA=/data

EXPOSE 8790
VOLUME ["/data", "/root/.omp"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:8790/api/health || exit 1

CMD ["node", "server/index.js"]
