FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

# Usuário UID 1000 exigido pelo Hugging Face Spaces
RUN useradd -m -u 1000 user
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && mkdir -p /app/sessao /app/saida && chown -R user:user /app

USER user

ENV NODE_ENV=production
ENV PORT=7860
ENV AUTH_DIR=/app/sessao

EXPOSE 7860

CMD ["npm", "start"]
