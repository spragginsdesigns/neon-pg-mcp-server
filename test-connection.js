#!/usr/bin/env node

import pg from 'pg';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
config({ path: join(__dirname, '.env') });

const CONNECTION_STRING = process.env.NEON_PG_CONNECTION_STRING;

if (!CONNECTION_STRING) {
  console.error('❌ NEON_PG_CONNECTION_STRING not found in environment');
  process.exit(1);
}

console.log('✅ Connection string loaded successfully');
console.log(`📍 Connection host: ${new URL(CONNECTION_STRING.replace('postgresql://', 'http://')).hostname}`);

// Test the connection
const pool = new pg.Pool({
  connectionString: CONNECTION_STRING,
  ssl: {
    rejectUnauthorized: true,
  },
  max: 1
});

try {
  console.log('\n🔄 Testing database connection...');
  const result = await pool.query('SELECT version()');
  console.log('✅ Connection successful!');
  console.log(`📊 PostgreSQL version: ${result.rows[0].version}`);
  
  // Test getting tables
  console.log('\n🔄 Fetching tables...');
  const tablesResult = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    LIMIT 5
  `);
  
  if (tablesResult.rows.length > 0) {
    console.log('✅ Found tables:');
    tablesResult.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
  } else {
    console.log('ℹ️  No tables found in public schema');
  }
  
} catch (error) {
  console.error('❌ Connection failed:', error.message);
} finally {
  await pool.end();
  console.log('\n👋 Test complete');
}
