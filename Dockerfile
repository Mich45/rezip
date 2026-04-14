# Multi-stage build to include FFmpeg
FROM mwader/static-ffmpeg:7.1 AS ffmpeg
FROM node:20-alpine

WORKDIR /app

# Copy FFmpeg from the static-ffmpeg image
COPY --from=ffmpeg /ffmpeg /usr/local/bin/
COPY --from=ffmpeg /ffprobe /usr/local/bin/

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application source
COPY . .

# Create uploads directory
RUN mkdir -p /app/uploads

# Expose the local port
EXPOSE 3000

CMD ["node", "server.js"]
