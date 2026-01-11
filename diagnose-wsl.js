#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 WSL MCP Server Diagnostics');
console.log('=====================================\n');

// Check if running in WSL
const isWSL = async () => {
  try {
    const procVersion = await fs.readFile('/proc/version', 'utf8');
    return procVersion.toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
};

// Check Node.js installation
console.log('📦 Node.js Environment:');
console.log(`   Version: ${process.version}`);
console.log(`   Executable: ${process.execPath}`);
console.log(`   Platform: ${os.platform()}`);
console.log(`   WSL: ${await isWSL() ? 'Yes' : 'No'}`);

// Check for .env file
console.log('\n📄 Environment File:');
try {
  const envPath = join(__dirname, '.env');
  const envStat = await fs.stat(envPath);
  console.log(`   ✅ .env file exists (${envStat.size} bytes)`);
  
  // Check line endings
  const envContent = await fs.readFile(envPath, 'utf8');
  const hasCRLF = envContent.includes('\r\n');
  console.log(`   Line endings: ${hasCRLF ? '❌ CRLF (Windows)' : '✅ LF (Unix)'}`);
  
  // Check if connection string is present
  const hasConnString = envContent.includes('NEON_PG_CONNECTION_STRING');
  console.log(`   Connection string: ${hasConnString ? '✅ Present' : '❌ Missing'}`);
} catch (error) {
  console.log(`   ❌ .env file not found: ${error.message}`);
}

// Check package.json
console.log('\n📦 Dependencies:');
try {
  const packageJson = JSON.parse(await fs.readFile(join(__dirname, 'package.json'), 'utf8'));
  const deps = packageJson.dependencies || {};
  
  const requiredDeps = ['@modelcontextprotocol/sdk', 'pg', 'dotenv'];
  for (const dep of requiredDeps) {
    if (deps[dep]) {
      console.log(`   ✅ ${dep}: ${deps[dep]}`);
    } else {
      console.log(`   ❌ ${dep}: Missing`);
    }
  }
} catch (error) {
  console.log(`   ❌ Could not read package.json: ${error.message}`);
}

// Check file permissions
console.log('\n🔐 File Permissions:');
const checkFile = async (filename) => {
  try {
    const filePath = join(__dirname, filename);
    const stats = await fs.stat(filePath);
    const perms = (stats.mode & parseInt('777', 8)).toString(8);
    const executable = stats.mode & fs.constants.X_OK ? '✅ Executable' : '❌ Not executable';
    console.log(`   ${filename}: ${perms} ${executable}`);
  } catch (error) {
    console.log(`   ${filename}: ❌ Not found`);
  }
};

await checkFile('pg-mcp-server.js');
await checkFile('run-wsl.js');
await checkFile('run-wsl.sh');

// Check network connectivity
console.log('\n🌐 Network Connectivity:');
try {
  // Try to resolve Neon hostname
  const { config } = await import('dotenv');
  config({ path: join(__dirname, '.env') });
  
  if (process.env.NEON_PG_CONNECTION_STRING) {
    const url = new URL(process.env.NEON_PG_CONNECTION_STRING.replace('postgresql://', 'http://'));
    console.log(`   Neon Host: ${url.hostname}`);
    
    try {
      execSync(`nslookup ${url.hostname}`, { stdio: 'pipe' });
      console.log(`   ✅ DNS resolution successful`);
    } catch {
      console.log(`   ❌ DNS resolution failed`);
    }
  } else {
    console.log(`   ❌ Connection string not loaded`);
  }
} catch (error) {
  console.log(`   ❌ Network check failed: ${error.message}`);
}

// Suggest fixes
console.log('\n💡 Suggested Fixes:');
console.log('1. If line endings are CRLF, run: dos2unix *.js .env');
console.log('2. If files are not executable: chmod +x *.js *.sh');
console.log('3. If dependencies are missing: pnpm install');
console.log('4. If DNS fails, check WSL network: sudo resolvconf -u');

console.log('\n✨ Run test-connection.js to verify database connectivity');
