FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js index.html ./
EXPOSE 8080
CMD ["node", "server.js"]
