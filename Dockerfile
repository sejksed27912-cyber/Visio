# ---- Build React ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY src ./src
COPY server.js ./

# Build React (production)
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine
WORKDIR /app

# deps runtime (inclut express/socket.io)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/build ./build
COPY --from=build /app/server.js ./server.js

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
