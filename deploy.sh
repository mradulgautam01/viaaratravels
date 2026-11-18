#!/bin/bash
# Viaara production deployment
# Usage: ./deploy.sh  (run on the EC2 host)
set -e

echo "Checking working tree..."
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree has local changes. Aborting."
  exit 1
fi

echo "Pulling latest code..."
git pull --ff-only origin main

echo "Installing production dependencies..."
npm ci --omit=dev

echo "Restarting Viaara..."
pm2 restart viaara --update-env

echo "Deployment completed."
pm2 status
