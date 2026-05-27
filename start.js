const dotenv = require('dotenv');
const { spawn } = require('child_process');

dotenv.config();

console.log('🚀 Starting Intercom + Feedback Bot System...\n');

const apiProcess = spawn('node', ['api.js'], {
  stdio: 'inherit'
});

const botProcess = spawn('node', ['discord-bot.js'], {
  stdio: 'inherit'
});

process.on('SIGTERM', () => {
  console.log('\n📛 Shutting down...');
  apiProcess.kill();
  botProcess.kill();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n📛 Shutting down...');
  apiProcess.kill();
  botProcess.kill();
  process.exit(0);
});

apiProcess.on('error', (error) => {
  console.error('❌ API process error:', error);
});

botProcess.on('error', (error) => {
  console.error('❌ Bot process error:', error);
});
