#!/bin/sh

set -eu

echo "Deploying prisma migrations"

pnpx prisma@6.6.0  migrate deploy --schema ./apps/web/prisma/schema.prisma

echo "Starting web server"

node apps/web/server.js
