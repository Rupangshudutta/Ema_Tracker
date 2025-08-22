const fs = require('fs');
const { execSync } = require('child_process');

// Create logs directory if it doesn't exist
if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs');
  console.log('Created logs directory');
}

// Check if PM2 is installed
try {
  execSync('pm2 --version', { stdio: 'ignore' });
  console.log('PM2 is already installed');
} catch (error) {
  console.log('Installing PM2 globally...');
  execSync('npm install pm2 -g');
  console.log('PM2 installed successfully');
}

console.log('\n=== EMA Tracker PM2 Setup ===');
console.log('To start the EMA Tracker with PM2, run:');
console.log('pm2 start ecosystem.config.js');
console.log('\nTo ensure it starts on system reboot:');
console.log('pm2 startup');
console.log('pm2 save');
console.log('\nTo monitor your application:');
console.log('pm2 monit');
console.log('\nTo view logs:');
console.log('pm2 logs ema-tracker');
console.log('\nTo stop the application:');
console.log('pm2 stop ema-tracker');
