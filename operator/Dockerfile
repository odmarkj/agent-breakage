FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

# Install helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production=false

# Build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Copy kubectl and helm from build stage
COPY --from=base /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=base /usr/local/bin/helm /usr/local/bin/helm

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for Claude CLI (refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash emily \
    && mkdir -p /app/workspace && chown emily:emily /app/workspace

COPY --from=base /app/dist ./dist

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "dist/server.js"]
