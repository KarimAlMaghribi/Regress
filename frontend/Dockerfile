# frontend/Dockerfile
# syntax=docker/dockerfile:1.7-labs
FROM node:20-bullseye AS deps
WORKDIR /app

# nur Manifest + Lock zuerst
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    node -v && npm -v && \
    test -f package-lock.json && \
    npm ci --no-audit --fund=false --prefer-offline --progress=false

FROM deps AS build
# Debug: zeig im CI-Log, welche Manifeste wirklich drin sind
RUN echo "=== package.json (head) ===" && sed -n '1,60p' package.json && \
    echo "=== package-lock present? ===" && ls -l package-lock.json

COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx","-g","daemon off;"]
