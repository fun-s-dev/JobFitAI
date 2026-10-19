require('dotenv').config();
const { loadConfig, ConfigError } = require('./src/v2/config/env');

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n❌ Fatal Startup Error: Invalid Configuration\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const app = require('./src/app');
const connectDB = require('./src/config/database');
const { cleanupInterruptedJobs } = require('./src/v2/services/jobRunner');

const PORT = config.PORT;

async function startServer() {
  await connectDB();
  await cleanupInterruptedJobs().catch((err) => {
    console.error('Failed to cleanup interrupted jobs on boot:', err.message);
  });

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

startServer();