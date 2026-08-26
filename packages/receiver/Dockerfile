FROM node:24-alpine

RUN apk add --no-cache bash fd git ripgrep \
    && mkdir -p /workspace

WORKDIR /app
COPY server.js ./server.js

ENV PORT=8080 \
    WORKSPACE_ROOT=/workspace
EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
