# Stage 1: Build frontend
FROM node:24-alpine AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run lib-build -- --configuration production \
 && npm run build -- --configuration production


# Stage 2: Build backend (compile TypeScript)
FROM node:24-alpine AS backend-build
RUN npm install -g pnpm@10
WORKDIR /build
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/ .
RUN pnpm build


# Stage 3: Production runtime
FROM node:24-alpine AS production
RUN npm install -g pnpm@10
WORKDIR /app

# Production dependencies only
COPY --from=backend-build /build/package.json /build/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Compiled backend — process.cwd() = /app, so node dist/server.js works from here
COPY --from=backend-build /build/dist ./dist

# Config YAML — process.cwd()/config = /app/config
COPY --from=backend-build /build/config/application.default.yaml ./config/application.default.yaml

# Frontend build — process.cwd()/static = /app/static
COPY --from=frontend /build/dist/data-dashboard/browser ./static

EXPOSE 8080
CMD ["node", "dist/server.js"]
