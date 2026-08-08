# Postledger — zero-dependency double-entry ledger.
#
# There is no build step: Node 22.6+ runs TypeScript directly and ships
# node:sqlite, so the image is just the runtime plus the source.
FROM node:22-alpine

# sqlite3 CLI is not required to run postledger, but it is what you reach for
# when you want to prove to yourself that the triggers really do refuse writes.
RUN apk add --no-cache sqlite

WORKDIR /app
COPY package.json server.json LICENSE README.md ./
COPY src/ ./src/
COPY tests/ ./tests/

RUN chmod +x src/cli.ts && ln -s /app/src/cli.ts /usr/local/bin/postledger

# Books live here. Mount a volume so they survive the container.
#   docker run -v "$PWD/books:/books" postledger init /books/demo.db --name "Acme" --currency USD
VOLUME ["/books"]
ENV NODE_OPTIONS=--no-warnings
ENV POSTLEDGER_BOOK=/books/ledger.db

# Prove the image works at build time: a full ledger lifecycle in one layer.
# If any invariant is broken this build fails rather than shipping a bad image.
RUN node tests/invariants.mjs && node tests/money.mjs && node tests/engine.mjs \
 && node tests/forensics.mjs && node tests/e2e.mjs

ENTRYPOINT ["postledger"]
CMD ["--help"]
