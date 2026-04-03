FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js .
EXPOSE 3402
CMD ["node", "server.js"]
