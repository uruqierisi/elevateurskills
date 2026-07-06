# Sandbox image for elevateurskills agents.
# Agents run every shell/file/test command inside a container built from this
# image, with the run workspace bind-mounted at /workspace. It carries the
# default generated-project toolchain: Node 20 + npm, plus git and the libs
# Playwright/Chromium need for the frontend smoke test.
FROM node:20-bookworm-slim

# Toolchain + Chromium runtime dependencies (for optional browser_check).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*

# Postgres client is handy for backend migration checks; harmless if unused.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Commands are injected per-exec (`docker run ... sh -lc "<command>"`), so the
# default command just keeps the image usable interactively.
CMD ["bash"]
