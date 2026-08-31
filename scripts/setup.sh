#!/bin/bash

# Setup script for backend development
set -e

echo "🚀 Setting up backend..."

# Check if .env exists
if [ ! -f .env ]; then
  echo "⚠️  .env file not found. Creating from env file..."
  cp env .env
  echo "✅ Created .env file. Please update DATABASE_URL if needed."
fi

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install

# Generate Prisma client
echo "🔧 Generating Prisma client..."
pnpm prisma:generate

# Check if database is running
echo "🔍 Checking database connection..."
if pnpm prisma db push --skip-generate > /dev/null 2>&1; then
  echo "✅ Database connection successful!"
else
  echo "⚠️  Database connection failed. Make sure PostgreSQL is running."
  echo "   You can start it with: docker-compose up -d postgres"
fi

echo "✅ Setup complete!"
echo ""
echo "To start the development server:"
echo "  pnpm start:dev"
echo ""
echo "To start with Docker:"
echo "  docker-compose up -d"
