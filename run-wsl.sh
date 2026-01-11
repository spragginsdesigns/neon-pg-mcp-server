#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Neon PostgreSQL MCP Server - WSL Runner${NC}"
echo -e "${BLUE}===========================================${NC}\n"

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Change to script directory
cd "$SCRIPT_DIR"

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ Error: .env file not found!${NC}"
    echo -e "${YELLOW}Please create a .env file with your NEON_PG_CONNECTION_STRING${NC}"
    exit 1
fi

# Load environment variables from .env
export $(cat .env | grep -v '^#' | xargs)

# Verify environment variable is set
if [ -z "$NEON_PG_CONNECTION_STRING" ]; then
    echo -e "${RED}❌ Error: NEON_PG_CONNECTION_STRING not found in .env${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Environment variables loaded${NC}"

# Check Node.js version
NODE_VERSION=$(node --version)
echo -e "${GREEN}✅ Node.js version: $NODE_VERSION${NC}"

# Check if we're in WSL
if grep -q Microsoft /proc/version; then
    echo -e "${GREEN}✅ Running in WSL${NC}"
else
    echo -e "${YELLOW}⚠️  Not running in WSL${NC}"
fi

# Fix line endings if needed
if command -v dos2unix &> /dev/null; then
    echo -e "\n${BLUE}🔧 Converting line endings...${NC}"
    dos2unix *.js 2>/dev/null
    echo -e "${GREEN}✅ Line endings converted${NC}"
fi

# Run the server
echo -e "\n${BLUE}🚀 Starting Neon PostgreSQL MCP Server...${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop${NC}\n"

# Use the run-wsl.js wrapper that loads dotenv
exec node run-wsl.js
