#!/usr/bin/env node

// Load environment variables from .env file
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
config({ path: join(__dirname, '.env') });

// Import and run the server
import('./pg-mcp-server.js');
