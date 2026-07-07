# Sandbox image for elevateurskills agents.
#
# Agents run every shell/file/test command inside a container built from this
# image, with the run workspace bind-mounted at /workspace. The whole point of
# being opinionated (Node + Express + Prisma + PostgreSQL) is that this image is
# PRE-CONFIGURED for that exact stack, so the agent never has to fight the
# container to get Prisma working.
#
# Full node:20-bookworm (NOT alpine, NOT slim):
#   - alpine uses musl; Prisma's prebuilt query engines need glibc, so alpine is
#     what causes the `libquery_engine*.so.node` load failures. Debian glibc
#     loads the engine on the first try.
#   - the full (non-slim) image ships python3/make/g++, so any native addon
#     (bcrypt, etc.) builds without extra apt installs.
FROM node:20-bookworm

# System deps: OpenSSL (Prisma's query engine links against it) plus git and the
# shared libs headless Chromium needs for the optional frontend browser_check.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl libssl-dev \
      git ca-certificates \
      postgresql-client \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*

# Prisma engine configuration for this container:
#   - pull engines from the official mirror,
#   - force the *binary* query engine (not WASM), the more reliable path inside
#     a Linux container.
ENV PRISMA_ENGINES_MIRROR=https://binaries.prisma.io
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=binary

# Working directory for the generated project (matches the bind mount).
WORKDIR /workspace

# Global tooling the agents commonly reach for. Having the Prisma CLI already
# present means `npx prisma generate` / `npx prisma migrate` don't have to
# re-download the CLI on every run.
RUN npm i -g prisma typescript ts-node tsx jest vitest

# Best-effort: warm the Prisma query/schema engines into the image at BUILD time
# (running `prisma generate` on a throwaway schema forces the engine download),
# so a connected machine never re-downloads them at runtime. Non-fatal (`|| true`):
# on a restricted network the fetch is skipped here and engines download lazily
# on first use instead — the build never fails on this.
RUN mkdir -p /tmp/prisma-warm \
 && printf 'datasource db {\n  provider = "postgresql"\n  url = "postgresql://u:p@localhost:5432/d"\n}\ngenerator client {\n  provider = "prisma-client-js"\n}\nmodel Warm {\n  id String @id @default(uuid())\n}\n' > /tmp/prisma-warm/schema.prisma \
 && (cd /tmp/prisma-warm && prisma generate --schema=/tmp/prisma-warm/schema.prisma || true) \
 && rm -rf /tmp/prisma-warm/node_modules

# Commands are injected per-exec (`docker run ... sh -lc "<command>"`), so the
# default command just keeps the image usable interactively.
CMD ["bash"]
