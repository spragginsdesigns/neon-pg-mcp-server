# Running Neon PostgreSQL MCP Server on WSL

## Quick Start

1. **Install dependencies** (if not already done):
   ```bash
   cd /mnt/c/Users/Owner/Documents/Cline/MCP/neon-pg-server
   pnpm install
   ```

2. **Test the connection**:
   ```bash
   pnpm test
   # or
   node test-connection.js
   ```

3. **Run the server**:
   ```bash
   # Method 1: Using the WSL script (recommended)
   chmod +x run-wsl.sh
   ./run-wsl.sh

   # Method 2: Using npm script
   pnpm start:wsl

   # Method 3: Direct with environment variable
   source .env && node pg-mcp-server.js
   ```

## Common WSL Issues and Fixes

### 1. **Line Ending Issues (CRLF vs LF)**
If you get syntax errors, convert line endings:
```bash
# Install dos2unix if needed
sudo apt-get install dos2unix

# Convert all JS files
dos2unix *.js
```

### 2. **Permission Issues**
Make scripts executable:
```bash
chmod +x run-wsl.sh
chmod +x *.js
```

### 3. **Node.js Path Issues**
Ensure you're using WSL's Node.js:
```bash
which node
# Should show: /home/spragginsdesigns/.nvm/versions/node/v22.16.0/bin/node
# NOT: /mnt/c/Program Files/nodejs/node
```

### 4. **Environment Variables Not Loading**
The `.env` file might not be automatically loaded. Solutions:
- Use the `run-wsl.js` wrapper (recommended)
- Manually export: `source .env`
- Use the bash script: `./run-wsl.sh`

### 5. **Network Issues in WSL2**
If you can't connect to Neon:
```bash
# Check DNS resolution
nslookup ep-cool-night-a4fxktsc-pooler.us-east-1.aws.neon.tech

# Test with curl
curl -I https://neon.tech
```

## Testing the MCP Server

### Manual Testing
```bash
# Start the server
node run-wsl.js

# In another terminal, send a test request
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node run-wsl.js
```

### Integration Testing with Claude Desktop

1. Update Claude Desktop config (Windows path):
   ```json
   {
     "neon-postgres": {
       "command": "wsl",
       "args": [
         "bash",
         "-c",
         "cd /mnt/c/Users/Owner/Documents/Cline/MCP/neon-pg-server && node run-wsl.js"
       ]
     }
   }
   ```

2. Or use the full WSL path:
   ```json
   {
     "neon-postgres": {
       "command": "C:\\Windows\\System32\\wsl.exe",
       "args": [
         "node",
         "/mnt/c/Users/Owner/Documents/Cline/MCP/neon-pg-server/run-wsl.js"
       ]
     }
   }
   ```

## Debugging

### Enable Debug Output
```bash
# Set debug environment variable
export DEBUG=mcp:*
./run-wsl.sh
```

### Check Server Logs
The server logs to stderr, so you'll see output in the terminal.

### Test Individual Components
```bash
# Test database connection only
node test-connection.js

# Test with explicit env loading
node -r dotenv/config pg-mcp-server.js
```

## File Structure for WSL
```
neon-pg-server/
├── .env                    # Environment variables (check line endings!)
├── pg-mcp-server.js       # Main server file
├── run-wsl.js             # WSL wrapper with dotenv
├── run-wsl.sh             # Bash script for WSL
├── test-connection.js     # Connection test script
└── package.json           # Updated with WSL scripts
```

## Troubleshooting Checklist

- [ ] Node.js v18+ installed in WSL (`node --version`)
- [ ] Using WSL's Node, not Windows Node (`which node`)
- [ ] `.env` file exists and has correct line endings
- [ ] Environment variable is loaded (`echo $NEON_PG_CONNECTION_STRING`)
- [ ] All `.js` files have LF line endings (use `file *.js` to check)
- [ ] Scripts have execute permissions (`ls -la *.sh`)
- [ ] Network connectivity works (`ping google.com`)
- [ ] PostgreSQL client can connect (test with `psql` if installed)
