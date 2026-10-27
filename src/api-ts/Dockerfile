# Build with the `src` directory as the context so the shared SQL migrations
# and seeds in src/database can be copied in:
#   docker build -f src/api-ts/Dockerfile src
FROM node:24-alpine AS builder

WORKDIR /app
COPY api-ts/package*.json ./
RUN npm ci
COPY api-ts/ .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY api-ts/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# The compiled code resolves ../../../database from /app/dist/db, i.e. /database
COPY database /database

ENV PORT=3000
ENV DB_FILE=/data/app.db

EXPOSE 3000
CMD ["npm", "start"]
