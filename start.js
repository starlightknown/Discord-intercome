const { spawn } = require('child_process');

// Start main API
const api = spawn('node', ['api.js']);
api.stdout.on('data', (data) => console.log(`API: ${data}`));
api.stderr.on('data', (data) => console.error(`API ERROR: ${data}`));

// Start Discord bot
const bot = spawn('node', ['discord-bot.js']);
bot.stdout.on('data', (data) => console.log(`BOT: ${data}`));
bot.stderr.on('data', (data) => console.error(`BOT ERROR: ${data}`));

console.log('🚀 Started both services');
