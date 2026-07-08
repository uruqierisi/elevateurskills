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

# Prisma engine configuration for this container.
#
# Do NOT pin PRISMA_ENGINES_MIRROR. Prisma's default engine resolution already
# picks a reachable host (and has fallbacks); pinning a single hostname turns a
# transient DNS/CDN problem on that one host into a total, unrecoverable failure
# of every `prisma generate`. We were bitten by exactly this: the previously
# pinned `binaries.prisma.io` went NXDOMAIN from some networks, so no engine
# could ever download even though the default S3 host resolved fine.
#
# Force the *binary* query engine (not WASM) — the more reliable path in a Linux
# container.
ENV PRISMA_CLI_QUERY_ENGINE_TYPE=binary

# Working directory for the generated project (matches the bind mount).
WORKDIR /workspace

# Global tooling the agents commonly reach for. Having the Prisma CLI already
# present means `npx prisma generate` / `npx prisma migrate` don't have to
# re-download the CLI on every run.
#
# Prisma is pinned to the v6 line on purpose. Prisma 7 is a breaking rewrite:
# the classic `datasource { url = env("DATABASE_URL") }` schema and the
# `prisma-client-js` generator this stack (and the backend role's mandated
# schema) rely on are rejected by v7 (error P1012 — url must move to
# prisma.config.ts). An unpinned `npm i -g prisma` silently pulls v7 `latest`
# and breaks every generated backend. v6 is the current classic-schema line.
RUN npm i -g prisma@6 typescript ts-node tsx jest vitest

# NOTE: there is deliberately no build-time "engine warm" step. It never bought
# anything: a generated project's engines are downloaded into the bind-mounted
# workspace during `npm install`/`prisma generate`, not into the image, so a warm
# only ever primed the CLI's own cache — and a genuinely offline run can't
# `npm install` the project deps in the first place. Now that the engine mirror
# is unpinned (see above), whenever npm can reach the registry the Prisma engine
# host is reachable too, so on-demand download at run time is reliable. Warming
# only added build fragility (dead-host fetch, v6/v7 skew, root-vs-node cache
# permissions), so it was removed.

# Commands are injected per-exec (`docker run ... sh -lc "<command>"`), so the
# default command just keeps the image usable interactively.
CMD ["bash"]
