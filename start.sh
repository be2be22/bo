#!/bin/bash

# Ensure local storage directory exists
mkdir -p /tmp/telegram-bot-api

echo "Starting Telegram Bot API Local Server..."
# Run the pre-compiled Telegram Bot API server in the background
# --local flag enables saving files directly to local disk
# --dir specifies the root directory for downloaded files
# We pass TELEGRAM_API_ID and TELEGRAM_API_HASH from environmental variables
/usr/local/bin/telegram-bot-api \
  --api-id="${TELEGRAM_API_ID}" \
  --api-hash="${TELEGRAM_API_HASH}" \
  --local \
  --dir=/tmp/telegram-bot-api &

echo "Waiting for Telegram Bot API server to boot..."
sleep 4

echo "Starting Node.js Bot Daemon..."
exec npm run start
