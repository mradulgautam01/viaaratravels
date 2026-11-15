#!/bin/bash
# deploy.sh — Run this on EC2 to pull latest and restart
# Usage: ./deploy.sh

set -e

echo "▶ Pulling latest from GitHub..."
git pull origin main

echo "▶ Installing dependencies..."
npm install --production

echo "▶ Running migrations..."
node db/migrate.js

echo "▶ Restarting app..."
pm2 restart viaara || pm2 start server.js --name viaara

echo "✓ Deployed successfully!"
pm2 status
