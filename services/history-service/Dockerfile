FROM node:18
WORKDIR /app
COPY services/history-service/package.json ./package.json
RUN npm install --production
COPY services/history-service/ .
EXPOSE 8090
CMD ["node", "src/server.js"]
