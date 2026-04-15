FROM mwader/static-ffmpeg:7.1 AS ffmpeg
FROM node:20-alpine

WORKDIR /app

COPY --from=ffmpeg /ffmpeg /usr/local/bin/
COPY --from=ffmpeg /ffprobe /usr/local/bin/

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "dist/server.js"]