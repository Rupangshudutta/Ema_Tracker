const brain = require('brain.js');
const os = require('os');
const fs = require('fs').promises;
const path = require('path');

class ML_OS_Module {
  constructor(config, directories) {
    this.config = config;
    this.directories = directories;
    this.neuralNet = this.initializeModel();
    this.modelVersion = this.getModelVersion();
  }

  initializeModel() {
    return new brain.NeuralNetworkGPU({
      hiddenLayers: [128, 64],
      activation: 'leaky-relu',
      learningRate: 0.01,
      ...this.config.ML_MODEL_OPTIONS
    });
  }

  async loadModel() {
    try {
      const modelPath = path.join(this.directories.MODEL_PATH, 'model.json');
      if (fs.existsSync(modelPath)) {
        const modelData = await fs.readFile(modelPath, 'utf8');
        this.neuralNet.fromJSON(JSON.parse(modelData));
        return true;
      }
      return false;
    } catch (error) {
      throw new Error(`Model load failed: ${error.message}`);
    }
  }

  systemHealthCheck() {
    return {
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        usage: Math.round((1 - os.freemem() / os.totalmem()) * 100)
      },
      cpu: {
        load: os.loadavg(),
        cores: os.cpus().length
      }
    };
  }

  async trainModel(trainingData) {
    if (!this.validateSystemForTraining()) {
      throw new Error('System resources insufficient for training');
    }

    const trainingSet = this.prepareTrainingData(trainingData);
    const results = await this.neuralNet.trainAsync(trainingSet, this.config.ML_TRAINING_OPTIONS);

    await this.saveModel();
    return results;
  }

  prepareTrainingData(rawData) {
    return Array.from(rawData.entries()).flatMap(([symbol, data]) =>
      data.map(entry => ({
        input: this.normalizeInput(entry),
        output: [entry.future_price_change > 0 ? 1 : 0]
      }))
    );
  }

  normalizeInput(entry) {
    return [
      entry.price / entry.ema,
      entry.volume / this.config.VOLUME_THRESHOLD,
      entry.priceChangePercent / 100
    ];
  }

  async saveModel() {
    const modelPath = path.join(this.directories.MODEL_PATH, 'model.json');
    await fs.writeFile(modelPath, JSON.stringify(this.neuralNet.toJSON()));
    this.modelVersion = this.getModelVersion();
  }

  getModelVersion() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  validateSystemForTraining() {
    const { memory, cpu } = this.systemHealthCheck();
    return memory.usage < 85 && cpu.load[0] < cpu.cores * 0.75;
  }

  makePrediction(data) {
    const normalized = data.map(entry => this.normalizeInput(entry));
    const prediction = this.neuralNet.run(normalized.flat());
    return this.interpretPrediction(prediction[0]);
  }

  interpretPrediction(value) {
    return value > 0.65 ? 'bullish' : value < 0.35 ? 'bearish' : 'neutral';
  }
}

module.exports = ML_OS_Module;
