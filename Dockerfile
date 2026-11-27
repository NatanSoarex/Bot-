FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build && mkdir -p /app/sessao /app/saida && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV AUTH_DIR=/app/sessao

EXPOSE 3000

CMD ["npm", "start"]
