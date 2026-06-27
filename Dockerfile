# Use the official pre-compiled Telegram Bot API image as the base
FROM aiogram/telegram-bot-api:latest

# Install Node.js, NPM, and Bash using apk
RUN apk add --no-cache nodejs npm bash

# Create app directory
WORKDIR /usr/src/app

# Copy package metadata files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci

# Copy TypeScript configurations and sources
COPY tsconfig.json ./
COPY src/ ./src

# Build TypeScript to Javascript
RUN npm run build

# Copy and prepare startup script
COPY start.sh ./
RUN chmod +x start.sh

# Expose port (Internal Local API server runs on 8081)
EXPOSE 8081

# Reset base image ENTRYPOINT so our start.sh runs correctly
ENTRYPOINT []

# Execute startup setup
CMD ["./start.sh"]
