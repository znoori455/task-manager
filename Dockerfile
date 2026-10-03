# Single image for app + migrations + seed. Dev dependencies are kept so the
# migration/seed scripts (tsx) can run in the same container.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /app ./
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && npx next start -H 0.0.0.0"]
