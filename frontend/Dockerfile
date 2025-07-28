FROM node:18 AS builder
WORKDIR /app
COPY frontend/package.json ./package.json
RUN npm install
COPY frontend/ .
ARG VITE_INGEST_URL=http://localhost:8081
ARG VITE_HISTORY_WS=ws://localhost:8090
ARG VITE_API_URL=http://localhost:8084
ARG VITE_HISTORY_URL=http://localhost:8090
ENV VITE_INGEST_URL=$VITE_INGEST_URL \
    VITE_HISTORY_WS=$VITE_HISTORY_WS \
    VITE_API_URL=$VITE_API_URL \
    VITE_HISTORY_URL=$VITE_HISTORY_URL
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
