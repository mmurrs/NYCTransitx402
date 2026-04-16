FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js dual402.js index.html favicon.svg og.svg llms.txt skill.md ./
COPY data/ ./data/
EXPOSE 8080
CMD ["node", "server.js"]
