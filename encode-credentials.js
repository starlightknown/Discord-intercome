#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const credFile = process.argv[2] || './google-credentials.json';

if (!fs.existsSync(credFile)) {
  console.error(`❌ File not found: ${credFile}`);
  console.log('\nUsage: node encode-credentials.js [path-to-credentials-file]');
  console.log('Example: node encode-credentials.js ./google-credentials.json');
  process.exit(1);
}

try {
  const content = fs.readFileSync(credFile, 'utf-8');
  const base64 = Buffer.from(content).toString('base64');
  
  console.log('\n✅ Base64 encoded credentials:\n');
  console.log(base64);
  console.log('\n📋 Add this to your .env file:');
  console.log(`GOOGLE_CREDENTIALS_BASE64=${base64}\n`);
} catch (error) {
  console.error('❌ Error encoding credentials:', error.message);
  process.exit(1);
}
