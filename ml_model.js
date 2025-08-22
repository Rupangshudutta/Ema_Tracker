const ML_OS_Module = require('./ml_os_module');

const DEFAULT_MODEL_CONFIG = {
  ML_MODEL_OPTIONS: {
    iterations: 2000,
    errorThresh: 0.005,
    logPeriod: 100
  },
  ML_TRAINING_OPTIONS: {
    timeout: 3600000 // 1 hour
  }
};

function initializeMLOS(config, directories) {
  const mergedConfig = { ...DEFAULT_MODEL_CONFIG, ...config };
  const mlModule = new ML_OS_Module(mergedConfig, directories);

  // Warm up the model
  setImmediate(async () => {
    try {
      await mlModule.loadModel();
      console.log('[ML] Model initialized with version:', mlModule.modelVersion);
    } catch (error) {
      console.error('[ML] Initialization error:', error.message);
    }
  });

  return mlModule;
}

module.exports = { initializeMLOS };
