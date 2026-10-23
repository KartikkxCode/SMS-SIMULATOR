FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# Inside the container the app must listen on all interfaces; publish it as
# -p 127.0.0.1:3000:3000 so it is still only reachable from this computer.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
