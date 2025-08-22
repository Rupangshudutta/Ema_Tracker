const brain = require('brain.js');
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');
//const os = require('os');

// Directories
const ML_DATA_DIR = path.join(__dirname, 'ml_data');
const CSV_DATA_DIR = path.join(__dirname, 'csv_data');
const MODEL_PATH = path.join(__dirname, 'ml_models');
const LOG_DIR = path.join(__dirname, 'logs');

// Ensure directories exist
[ML_DATA_DIR, CSV_DATA_DIR, MODEL_PATH, LOG_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Model cache for better performance
const modelCache = new Map();

// Validate symbol to prevent path traversal attacks
function validateSymbol(symbol) {
    // Only allow alphanumeric characters and limited special chars
    if (!symbol || typeof symbol !== 'string' || !/^[A-Z0-9]+$/.test(symbol)) {
        log(`Invalid symbol format: ${symbol}`, 'error');
        return false;
    }
    return true;
}

// Enhanced logging with more details
function log(message, type = 'info', details = null) {
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${message}`;
    
    // Add error details if available
    if (details && type === 'error') {
        if (details instanceof Error) {
            logMessage += `\nStack: ${details.stack}`;
        } else {
            logMessage += `\nDetails: ${JSON.stringify(details)}`;
        }
    }

    // Console logging with colors
    switch (type) {
        case 'error':
            console.error(logMessage);
            break;
        case 'success':
            console.log(logMessage);
            break;
        case 'warning':
            console.log(logMessage);
            break;
        default:
            console.log(logMessage);
    }

    // File logging with better error handling
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        const logFile = path.join(LOG_DIR, `brain-ml-${new Date().toISOString().split('T')[0]}.log`);
        fs.appendFileSync(logFile, logMessage + '\n');
    } catch (logError) {
        console.error(`Failed to write to log file: ${logError.message}`);
    }
}

// Hyperparameter optimizer with improved error handling
const hyperparamOptimizer = {
    // Define hyperparameter search space
    searchSpace: {
        hiddenLayers: [
            [8], [16], [32], [64],
            [16, 8], [32, 16], [64, 32],
            [32, 16, 8], [64, 32, 16]
        ],
        learningRate: [0.01, 0.05, 0.1, 0.2],
        activation: ['sigmoid', 'relu', 'leaky-relu', 'tanh'],
        iterations: [500, 1000, 2000],
        errorThresh: [0.001, 0.005, 0.01]
    },

    // Find optimal hyperparameters using random search
    findOptimalHyperparameters: async function (trainingData) {
        try {
            if (!Array.isArray(trainingData) || trainingData.length === 0) {
                throw new Error('Invalid training data: empty or not an array');
            }

            log('Starting hyperparameter optimization with random search', 'info');

            // Split data for validation
            const splitIndex = Math.floor(trainingData.length * 0.7);
            const trainSet = trainingData.slice(0, splitIndex);
            const validationSet = trainingData.slice(splitIndex);

            // Number of random configurations to try
            const numTrials = 5;
            let bestConfig = null;
            let bestScore = -Infinity;

            for (let i = 0; i < numTrials; i++) {
                // Check memory usage before continuing
                if (!checkMemoryUsage()) {
                    log('Stopping hyperparameter search due to high memory usage', 'warning');
                    break;
                }

                // Generate random configuration
                const config = {
                    hiddenLayers: this.searchSpace.hiddenLayers[
                        Math.floor(Math.random() * this.searchSpace.hiddenLayers.length)
                    ],
                    learningRate: this.searchSpace.learningRate[
                        Math.floor(Math.random() * this.searchSpace.learningRate.length)
                    ],
                    activation: this.searchSpace.activation[
                        Math.floor(Math.random() * this.searchSpace.activation.length)
                    ],
                    iterations: this.searchSpace.iterations[
                        Math.floor(Math.random() * this.searchSpace.iterations.length)
                    ],
                    errorThresh: this.searchSpace.errorThresh[
                        Math.floor(Math.random() * this.searchSpace.errorThresh.length)
                    ]
                };

                log(`Trial ${i + 1}/${numTrials}: Testing configuration: ${JSON.stringify(config)}`, 'info');

                // Create and train model with this configuration
                const net = new brain.NeuralNetwork({
                    hiddenLayers: config.hiddenLayers,
                    learningRate: config.learningRate,
                    activation: config.activation
                });

                try {
                    await net.trainAsync(trainSet, {
                        iterations: config.iterations,
                        errorThresh: config.errorThresh,
                        log: false
                    });
                } catch (trainError) {
                    log(`Training error in trial ${i + 1}: ${trainError.message}`, 'error', trainError);
                    continue; // Skip to next trial
                }

                // Evaluate on validation set
                const predictions = validationSet.map(item => {
                    const output = net.run(item.input);
                    return denormalizeValue(output.priceChange, -10, 10);
                });

                const actual = validationSet.map(item =>
                    denormalizeValue(item.output.priceChange, -10, 10)
                );

                // Calculate direction accuracy (up/down)
                const directionAccuracy = predictions.filter((pred, i) =>
                    (pred > 0 && actual[i] > 0) || (pred < 0 && actual[i] < 0)
                ).length / predictions.length;

                // Calculate mean absolute error
                const mae = predictions.reduce((sum, pred, i) =>
                    sum + Math.abs(pred - actual[i]), 0) / predictions.length;

                // Score is a combination of direction accuracy and inverse MAE
                // We prioritize direction accuracy but also consider error
                const score = directionAccuracy - (mae * 0.1);

                log(`Trial ${i + 1} results: Direction Accuracy: ${(directionAccuracy * 100).toFixed(2)}%, MAE: ${mae.toFixed(4)}, Score: ${score.toFixed(4)}`, 'info');

                if (score > bestScore) {
                    bestScore = score;
                    bestConfig = config;
                    log(`New best configuration found with score ${score.toFixed(4)}`, 'success');
                }
            }

            log(`Hyperparameter optimization complete. Best configuration: ${JSON.stringify(bestConfig)}`, 'success');
            return bestConfig;
        } catch (error) {
            log(`Error in hyperparameter optimization: ${error.message}`, 'error', error);

            // Return default configuration if optimization fails
            return {
                hiddenLayers: [16, 8],
                learningRate: 0.1,
                activation: 'sigmoid',
                iterations: 1000,
                errorThresh: 0.005
            };
        }
    }
};

// Check memory usage to prevent OOM errors
function checkMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memoryUsage.heapTotal / 1024 / 1024);
    
    // Log memory usage if it's high
    if (heapUsedMB > 600) {
        log(`High memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB`, 'warning');
    }
    
    // Return true if memory usage is acceptable
    return heapUsedMB < 900; // 900MB threshold
}

// Create a neural network with adaptive learning rate
function createModel(hyperparams = null) {
    // Default hyperparameters if none provided
    const params = hyperparams || {
        hiddenLayers: [32,16],
        activation: 'sigmoid',
        learningRate: 0.01
    };

    return new brain.NeuralNetwork({
        hiddenLayers: params.hiddenLayers,
        activation: params.activation,
        learningRate: params.learningRate,
        leakyReluAlpha: 0.01, // For leaky-relu activation
        binaryThresh: 0.5,    // Threshold for binary outputs
        momentum: 0.1,        // Add momentum for faster learning
        decayRate: 0.999      // Learning rate decay
    });
}

// Improved normalization with better error handling
function normalizeValue(value, min, max) {
    // Validate inputs
    if (value === null || value === undefined || isNaN(value)) {
        return 0.5; // Default to middle value for missing data
    }
    
    if (min >= max) {
        log(`Invalid normalization range: min (${min}) must be less than max (${max})`, 'error');
        return 0.5;
    }

    // Clamp value to min-max range
    const clampedValue = Math.max(min, Math.min(max, value));
    return (clampedValue - min) / (max - min);
}

// Improved denormalization
function denormalizeValue(normalized, min, max) {
    // Validate inputs
    if (normalized === null || normalized === undefined || isNaN(normalized)) {
        log(`Invalid normalized value for denormalization: ${normalized}`, 'error');
        return (min + max) / 2; // Return middle of range
    }
    
    if (min >= max) {
        log(`Invalid denormalization range: min (${min}) must be less than max (${max})`, 'error');
        return (min + max) / 2;
    }
    
    // Clamp normalized value to 0-1 range
    const clampedNormalized = Math.max(0, Math.min(1, normalized));
    return clampedNormalized * (max - min) + min;
}

// Enhanced CSV validation
function validateCsvStructure(csvData, symbol) {
    try {
        if (!csvData || typeof csvData !== 'string') {
            log(`Invalid CSV data for ${symbol}: data is not a string`, 'error');
            return null;
        }
        
        const lines = csvData.split('\n').filter(line => line.trim() !== '');
        
        if (lines.length < 2) {
            log(`CSV data for ${symbol} has too few lines: ${lines.length}`, 'error');
            return null;
        }
        
        const headerLine = lines[0];
        const expectedColumns = ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'ema', 'ema_diff', 'rsi', 'macd', 'macd_signal', 'macd_hist', 'bb_width', 'volume_change', 'future_price_change'];

        // Check if header contains expected columns
        const headerColumns = headerLine.split(',').map(col => col.toLowerCase().trim());
        
        for (const expectedCol of expectedColumns) {
            if (!headerColumns.includes(expectedCol)) {
                log(`CSV header missing required column: ${expectedCol} for ${symbol}`, 'error');
                return null;
            }
        }
        
        // Validate a sample of data rows
        const sampleRow = lines[1].split(',');
        if (sampleRow.length !== headerColumns.length) {
            log(`CSV data row has incorrect number of columns for ${symbol}`, 'error');
            return null;
        }

        return lines;
    } catch (error) {
        log(`Error validating CSV structure: ${error.message}`, 'error', error);
        return null;
    }
}

// Load data for a symbol from CSV with improved validation
async function loadSymbolData(symbol, months = 3) {
    try {
        if (!validateSymbol(symbol)) {
            return [];
        }

        const csvPath = path.join(CSV_DATA_DIR, symbol, `${symbol}_training.csv`);
        if (!fs.existsSync(csvPath)) {
            log(`No CSV data found for ${symbol}`, 'warning');
            return [];
        }

        // Read CSV file
        const csvData = fs.readFileSync(csvPath, 'utf8');
        const lines = validateCsvStructure(csvData, symbol);
        
        if (!lines || lines.length < 2) {
            log(`Invalid CSV structure for ${symbol}`, 'error');
            return [];
        }
        
        const headers = lines[0].split(',').map(h => h.toLowerCase().trim());

        // Parse CSV data
        const data = [];
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;

            const values = lines[i].split(',');
            if (values.length !== headers.length) {
                log(`Line ${i} has incorrect number of columns for ${symbol}`, 'warning');
                continue;
            }

            const dataPoint = {};

            headers.forEach((header, index) => {
                const value = values[index];
                dataPoint[header] = value !== '' ? parseFloat(value) : null;
            });

            // Only include data points with future price change
            if (dataPoint.future_price_change !== null && !isNaN(dataPoint.future_price_change)) {
                data.push(dataPoint);
            }
        }

        log(`Loaded ${data.length} data points for ${symbol} from CSV`, 'info');
        return data;
    } catch (error) {
        log(`Error loading CSV data for ${symbol}: ${error.message}`, 'error', error);
        return [];
    }
}

// Export data to CSV for visualization and training
async function exportToCSV(symbol, data) {
    try {
        if (!validateSymbol(symbol) || !Array.isArray(data) || data.length === 0) {
            log(`Invalid data for CSV export: ${symbol}`, 'error');
            return null;
        }

        // Create directory for this symbol if it doesn't exist
        const symbolDir = path.join(CSV_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            fs.mkdirSync(symbolDir, { recursive: true });
        }

        // Create CSV file path
        const csvPath = path.join(symbolDir, `${symbol}_training_data.csv`);

        // Define CSV writer
        const csvWriter = createObjectCsvWriter({
            path: csvPath,
            header: [
                { id: 'timestamp', title: 'TIMESTAMP' },
                { id: 'symbol', title: 'SYMBOL' },
                { id: 'open', title: 'OPEN' },
                { id: 'high', title: 'HIGH' },
                { id: 'low', title: 'LOW' },
                { id: 'close', title: 'CLOSE' },
                { id: 'volume', title: 'VOLUME' },
                { id: 'ema', title: 'EMA' },
                { id: 'ema_diff', title: 'EMA_DIFF' },
                { id: 'rsi', title: 'RSI' },
                { id: 'macd', title: 'MACD' },
                { id: 'macd_signal', title: 'MACD_SIGNAL' },
                { id: 'macd_hist', title: 'MACD_HIST' },
                { id: 'bb_upper', title: 'BB_UPPER' },
                { id: 'bb_middle', title: 'BB_MIDDLE' },
                { id: 'bb_lower', title: 'BB_LOWER' },
                { id: 'bb_width', title: 'BB_WIDTH' },
                { id: 'atr', title: 'ATR' },
                { id: 'volume_change', title: 'VOLUME_CHANGE' },
                { id: 'future_price_change', title: 'FUTURE_PRICE_CHANGE' },
                { id: 'label', title: 'LABEL' }
            ]
        });

        // Filter out invalid data points
        const validData = data.filter(d => {
            return d && typeof d === 'object' && 
                   !isNaN(d.close) && 
                   !isNaN(d.future_price_change);
        });

        if (validData.length === 0) {
            log(`No valid data points for CSV export: ${symbol}`, 'warning');
            return null;
        }

        // Write data to CSV
        await csvWriter.writeRecords(validData);
        log(`CSV export completed for ${symbol} with ${validData.length} records`, 'success');

        return csvPath;
    } catch (error) {
        log(`Error exporting to CSV for ${symbol}: ${error.message}`, 'error', error);
        return null;
    }
}

// Calculate confidence intervals for predictions
function calculateConfidenceInterval(predictions, actual) {
    try {
        if (!Array.isArray(predictions) || !Array.isArray(actual) || 
            predictions.length === 0 || predictions.length !== actual.length) {
            throw new Error('Invalid inputs for confidence interval calculation');
        }

        // Calculate errors
        const errors = predictions.map((pred, i) => pred - actual[i]);

        // Calculate mean error
        const meanError = errors.reduce((sum, err) => sum + err, 0) / errors.length;

        // Calculate standard deviation
        const squaredDiffs = errors.map(err => Math.pow(err - meanError, 2));
        const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / errors.length;
        const stdDev = Math.sqrt(variance);

        // Calculate 95% confidence interval
        const confidenceInterval = 1.96 * stdDev / Math.sqrt(errors.length);

        return {
            meanError,
            stdDev,
            confidenceInterval
        };
    } catch (error) {
        log(`Error calculating confidence interval: ${error.message}`, 'error', error);
        return {
            meanError: 0,
            stdDev: 1,
            confidenceInterval: 1
        };
    }
}

// Validate features for prediction
function validateFeatures(features) {
    if (!features || typeof features !== 'object') {
        return false;
    }

    const requiredFeatures = ['priceDiff', 'rsi', 'macdHist', 'bbWidth', 'volume24h', 'volumeChange', 'atr'];
    
    for (const feature of requiredFeatures) {
        if (features[feature] === undefined || 
            features[feature] === null || 
            isNaN(features[feature])) {
            log(`Missing or invalid feature: ${feature}`, 'warning');
            return false;
        }
    }
    
    return true;
}

// Validate training data
function validateTrainingData(trainingData) {
    if (!Array.isArray(trainingData) || trainingData.length === 0) {
        return { valid: false, reason: 'Training data is empty or not an array' };
    }
    
    // Check sample of data points
    const sampleSize = Math.min(10, trainingData.length);
    
    for (let i = 0; i < sampleSize; i++) {
        const dataPoint = trainingData[i];
        
        // Check input features
        if (!dataPoint.input || typeof dataPoint.input !== 'object') {
            return { valid: false, reason: 'Data point missing input object' };
        }
        
        // Check required input features
        const requiredFeatures = ['ema_diff', 'rsi', 'macd', 'bbWidth', 'volume', 'volumeChange', 'atr'];
        for (const feature of requiredFeatures) {
            if (dataPoint.input[feature] === undefined || 
                dataPoint.input[feature] === null || 
                isNaN(dataPoint.input[feature])) {
                return { valid: false, reason: `Data point missing required feature: ${feature}` };
            }
        }
        
        // Check output
        if (!dataPoint.output || typeof dataPoint.output !== 'object') {
            return { valid: false, reason: 'Data point missing output object' };
        }
        
        if (dataPoint.output.priceChange === undefined || 
            dataPoint.output.priceChange === null || 
            isNaN(dataPoint.output.priceChange)) {
            return { valid: false, reason: 'Data point missing priceChange output' };
        }
    }
    
    return { valid: true };
}

// Generate model version with semantic versioning
function generateModelVersion() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    return `v${timestamp}-${randomSuffix}`;
}

// Save model version with proper versioning
function saveModelVersion(symbol, model, hyperparams, performance, features) {
    try {
        if (!validateSymbol(symbol)) {
            return null;
        }
        
        // Create model directory
        const modelDir = path.join(MODEL_PATH, symbol);
        if (!fs.existsSync(modelDir)) {
            fs.mkdirSync(modelDir, { recursive: true });
        }
        
        // Generate version
        const version = generateModelVersion();
        const versionDir = path.join(modelDir, version);
        fs.mkdirSync(versionDir, { recursive: true });
        
        // Save model
        fs.writeFileSync(
            path.join(versionDir, 'model.json'),
            JSON.stringify(model.toJSON())
        );
        
        // Save hyperparameters
        fs.writeFileSync(
            path.join(versionDir, 'hyperparams.json'),
            JSON.stringify(hyperparams)
        );
        
        // Save features
        fs.writeFileSync(
            path.join(versionDir, 'features.json'),
            JSON.stringify(features)
        );
        
        // Save performance metrics
        fs.writeFileSync(
            path.join(versionDir, 'performance.json'),
            JSON.stringify(performance)
        );
        
        // Create symlink to latest version
        const latestPath = path.join(modelDir, 'latest');
        if (fs.existsSync(latestPath)) {
            try {
                fs.unlinkSync(latestPath);
            } catch (error) {
                log(`Error removing existing symlink: ${error.message}`, 'warning');
                // Continue anyway
            }
        }
        
        try {
            fs.symlinkSync(versionDir, latestPath, 'dir');
        } catch (symlinkError) {
            // If symlink fails (e.g., on Windows), copy files instead
            log(`Symlink creation failed, copying files instead: ${symlinkError.message}`, 'warning');
            
            if (!fs.existsSync(latestPath)) {
                fs.mkdirSync(latestPath, { recursive: true });
            }
            
            fs.copyFileSync(
                path.join(versionDir, 'model.json'),
                path.join(latestPath, 'model.json')
            );
            
            fs.copyFileSync(
                path.join(versionDir, 'hyperparams.json'),
                path.join(latestPath, 'hyperparams.json')
            );
            
            fs.copyFileSync(
                path.join(versionDir, 'features.json'),
                path.join(latestPath, 'features.json')
            );
            
            fs.copyFileSync(
                path.join(versionDir, 'performance.json'),
                path.join(latestPath, 'performance.json')
            );
        }
        
        // Also save to root directory for backward compatibility
        fs.writeFileSync(
            path.join(modelDir, 'model.json'),
            JSON.stringify(model.toJSON())
        );
        
        fs.writeFileSync(
            path.join(modelDir, 'features.json'),
            JSON.stringify(features)
        );
        
        fs.writeFileSync(
            path.join(modelDir, 'performance.json'),
            JSON.stringify(performance)
        );
        
        return version;
    } catch (error) {
        log(`Error saving model version for ${symbol}: ${error.message}`, 'error', error);
        return null;
    }
}

// Analyze feature importance
async function analyzeFeatureImportance(symbol, trainingData) {
    try {
        if (!validateSymbol(symbol) || !trainingData || trainingData.length === 0) {
            return null;
        }
        
        // Create baseline model with all features
        const baselineModel = createModel();
        
        // Train baseline model
        const baselineResult = await baselineModel.trainAsync(trainingData, {
            iterations: 500,
            errorThresh: 0.01,
            log: false
        });
        
        // Get baseline error
        const baselineError = baselineResult.error;
        
        // Test each feature by removing it
        const features = Object.keys(trainingData[0].input);
        const featureImportance = [];
        
        for (const feature of features) {
            // Create modified training data without this feature
            const modifiedData = trainingData.map(item => {
                const newInput = { ...item.input };
                // Set feature to average value (0.5 in normalized space)
                newInput[feature] = 0.5;
                return { input: newInput, output: item.output };
            });
            
            // Train model without this feature
            const featureModel = createModel();
            const featureResult = await featureModel.trainAsync(modifiedData, {
                iterations: 500,
                errorThresh: 0.01,
                log: false
            });
            
            // Calculate importance as error increase when feature is removed
            const errorIncrease = featureResult.error - baselineError;
            const importance = Math.max(0, errorIncrease) * 100; // Convert to percentage
            
            featureImportance.push({
                feature,
                importance,
                errorIncrease
            });
        }
        
        // Sort by importance (descending)
        featureImportance.sort((a, b) => b.importance - a.importance);
        
        // Save feature importance
        const modelDir = path.join(MODEL_PATH, symbol);
        if (!fs.existsSync(modelDir)) {
            fs.mkdirSync(modelDir, { recursive: true });
        }
        
        fs.writeFileSync(
            path.join(modelDir, 'feature_importance.json'),
            JSON.stringify(featureImportance)
        );
        
        return featureImportance;
    } catch (error) {
        log(`Error analyzing feature importance for ${symbol}: ${error.message}`, 'error', error);
        return null;
    }
}

// Train model for price prediction with versioning and hyperparameter optimization
async function trainModelForSymbol(symbol) {
    try {
        // Validate symbol
        if (!validateSymbol(symbol)) {
            return null;
        }

        // Check memory usage
        if (!checkMemoryUsage()) {
            log(`Skipping training for ${symbol} due to high memory usage`, 'warning');
            return null;
        }

        // Load data for this symbol
        const data = await loadSymbolData(symbol);
        if (data.length < 100) {
            log(`Not enough data for ${symbol}: ${data.length} points`, 'warning');
            return null;
        }

        log(`Training model for ${symbol} with ${data.length} data points`, 'info');

        // Prepare training data
        const trainingData = data.map(d => ({
            input: {
                ema_diff: normalizeValue(d.ema_diff, -10, 10),
                rsi: normalizeValue(d.rsi, 0, 100),
                macd: normalizeValue(d.macd_hist, -1, 1),
                bbWidth: normalizeValue(d.bb_width, 0, 0.1),
                volume: normalizeValue(d.volume, 0, 1000000000),
                volumeChange: normalizeValue(d.volume_change, -1, 1),
                atr: normalizeValue(d.atr, 0, 1)
            },
            output: {
                priceChange: normalizeValue(d.future_price_change, -10, 10)
            }
        }));

        // Validate training data
        const validationResult = validateTrainingData(trainingData);
        if (!validationResult.valid) {
            log(`Invalid training data for ${symbol}: ${validationResult.reason}`, 'error');
            return null;
        }

        // Split data for A/B testing (80% training, 20% testing)
        const splitIndex = Math.floor(trainingData.length * 0.8);
        const trainingSet = trainingData.slice(0, splitIndex);
        const testingSet = trainingData.slice(splitIndex);

        log(`Split data for ${symbol}: ${trainingSet.length} training samples, ${testingSet.length} testing samples`, 'info');

        // Find optimal hyperparameters
        log(`Finding optimal hyperparameters for ${symbol}...`, 'info');
        const optimalHyperparams = await hyperparamOptimizer.findOptimalHyperparameters(trainingSet);
        log(`Found optimal hyperparameters for ${symbol}: ${JSON.stringify(optimalHyperparams)}`, 'success');

        // Create and train model with optimal hyperparameters
        const net = createModel(optimalHyperparams);

        // Log training progress to file
        const trainingLog = [];

        const result = await net.trainAsync(trainingSet, {
            iterations: optimalHyperparams.iterations || 1000,
            errorThresh: optimalHyperparams.errorThresh || 0.005,
            log: true,
            logPeriod: 100,
            callback: (stats) => {
                trainingLog.push(stats);
            }
        });

        // Calculate model performance on testing data
        const predictions = testingSet.map(item => {
            const output = net.run(item.input);
            return denormalizeValue(output.priceChange, -10, 10);
        });

        const actual = testingSet.map(item =>
            denormalizeValue(item.output.priceChange, -10, 10)
        );

        // Calculate mean absolute error
        const mae = predictions.reduce((sum, pred, i) =>
            sum + Math.abs(pred - actual[i]), 0) / predictions.length;

        // Calculate direction accuracy (up/down)
        const directionAccuracy = predictions.filter((pred, i) =>
            (pred > 0 && actual[i] > 0) || (pred < 0 && actual[i] < 0)
        ).length / predictions.length;

        // Calculate confidence intervals
        const confidenceStats = calculateConfidenceInterval(predictions, actual);

        log(`Model for ${symbol} trained with MAE: ${mae.toFixed(4)}, Direction Accuracy: ${(directionAccuracy * 100).toFixed(2)}%, CI: ±${confidenceStats.confidenceInterval.toFixed(4)}`, 'success');

        // Export performance metrics
        const performance = {
            mae,
            directionAccuracy,
            confidenceInterval: confidenceStats.confidenceInterval,
            stdDev: confidenceStats.stdDev,
            trainingIterations: result.iterations,
            trainingError: result.error,
            dataPoints: data.length,
            timestamp: new Date().toISOString()
        };

        // Save model with versioning
        const features = ['ema_diff', 'rsi', 'macd', 'bbWidth', 'volume', 'volumeChange', 'atr'];
        const version = saveModelVersion(symbol, net, optimalHyperparams, performance, features);

        // Analyze feature importance
        const featureImportance = await analyzeFeatureImportance(symbol, trainingSet);
        if (featureImportance) {
            log(`Feature importance analysis completed for ${symbol}`, 'success');
        }

        // Prune old model versions to save disk space
        await pruneOldModelVersions(symbol);

        // Clear model from cache to free memory
        if (modelCache.has(symbol)) {
            modelCache.delete(symbol);
        }

        return {
            model: net,
            performance,
            version,
            featureImportance
        };
    } catch (error) {
        log(`Error training model for ${symbol}: ${error.message}`, 'error', error);
        return null;
    }
}

// Prune old model versions to manage disk space
async function pruneOldModelVersions(symbol, keepCount = 5) {
    try {
        if (!validateSymbol(symbol)) {
            return false;
        }
        
        const modelDir = path.join(MODEL_PATH, symbol);
        if (!fs.existsSync(modelDir)) {
            return false;
        }
        
        // Get all version directories
        const versions = fs.readdirSync(modelDir)
            .filter(item => 
                fs.statSync(path.join(modelDir, item)).isDirectory() &&
                item.startsWith('v') &&
                item !== 'latest'
            )
            .sort((a, b) => {
                // Sort by creation time (newest first)
                try {
                    const timeA = fs.statSync(path.join(modelDir, a)).birthtime;
                    const timeB = fs.statSync(path.join(modelDir, b)).birthtime;
                    return timeB - timeA;
                } catch (error) {
                    // If birthtime is not available, use modification time
                    const timeA = fs.statSync(path.join(modelDir, a)).mtime;
                    const timeB = fs.statSync(path.join(modelDir, b)).mtime;
                    return timeB - timeA;
                }
            });
        
        // Keep the latest 'keepCount' versions
        if (versions.length <= keepCount) {
            return false; // Nothing to prune
        }
        
        // Delete older versions
        const versionsToDelete = versions.slice(keepCount);
        let deletedCount = 0;
        
        for (const version of versionsToDelete) {
            const versionPath = path.join(modelDir, version);
            
            try {
                // Delete directory recursively
                deleteFolderRecursive(versionPath);
                deletedCount++;
            } catch (error) {
                log(`Error deleting old model version ${version} for ${symbol}: ${error.message}`, 'warning');
            }
        }
        
        log(`Pruned ${deletedCount} old model versions for ${symbol}`, 'info');
        return true;
    } catch (error) {
        log(`Error pruning old model versions for ${symbol}: ${error.message}`, 'error', error);
        return false;
    }
}

// Helper function to recursively delete a folder
function deleteFolderRecursive(folderPath) {
    if (fs.existsSync(folderPath)) {
        fs.readdirSync(folderPath).forEach((file) => {
            const curPath = path.join(folderPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                // Recursive call
                deleteFolderRecursive(curPath);
            } else {
                // Delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(folderPath);
    }
}

// Predict price change with confidence intervals and ensemble methods
async function predictPriceChange(symbol, features) {
    try {
        // Validate inputs
        if (!validateSymbol(symbol) || !validateFeatures(features)) {
            return null;
        }

        // Try to use the latest model version first
        const modelDir = path.join(MODEL_PATH, symbol);
        const latestPath = path.join(modelDir, 'latest');

        let modelPath, featuresPath, hyperparamsPath, performancePath;

        if (fs.existsSync(latestPath)) {
            // Use the latest version
            modelPath = path.join(latestPath, 'model.json');
            featuresPath = path.join(latestPath, 'features.json');
            hyperparamsPath = path.join(latestPath, 'hyperparams.json');
            performancePath = path.join(latestPath, 'performance.json');
        } else {
            // Fall back to the root directory (backward compatibility)
            modelPath = path.join(modelDir, 'model.json');
            featuresPath = path.join(modelDir, 'features.json');
            performancePath = path.join(modelDir, 'performance.json');
        }

        if (!fs.existsSync(modelPath) || !fs.existsSync(featuresPath)) {
            return null;
        }

        // Check if model is in cache
        let net;
        if (modelCache.has(symbol)) {
            net = modelCache.get(symbol);
        } else {
            // Load model
            const modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
            
            // Create neural network with appropriate hyperparameters
            let hyperparams = null;
            if (fs.existsSync(hyperparamsPath)) {
                hyperparams = JSON.parse(fs.readFileSync(hyperparamsPath, 'utf8'));
            }
            
            net = createModel(hyperparams);
            net.fromJSON(modelJson);
            
            // Cache the model (limit cache size)
            if (modelCache.size > 50) {
                // Remove oldest model if cache is too large
                const oldestKey = modelCache.keys().next().value;
                modelCache.delete(oldestKey);
            }
            
            modelCache.set(symbol, net);
        }

        // Load feature names
        const featureNames = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
        featureNames();

        // Load performance data for confidence intervals
        let confidenceInterval = 0.5; // Default if not available
        let stdDev = 1.0;

        if (fs.existsSync(performancePath)) {
            const performance = JSON.parse(fs.readFileSync(performancePath, 'utf8'));
            confidenceInterval = performance.confidenceInterval || confidenceInterval;
            stdDev = performance.stdDev || stdDev;
        }

        // Normalize input features
        const input = {
            ema_diff: normalizeValue(features.priceDiff, -10, 10),
            rsi: normalizeValue(features.rsi, 0, 100),
            macd: normalizeValue(features.macdHist, -1, 1),
            bbWidth: normalizeValue(features.bbWidth, 0, 0.1),
            volume: normalizeValue(features.volume24h, 0, 1000000000),
            volumeChange: normalizeValue(features.volumeChange, -1, 1),
            atr: normalizeValue(features.atr, 0, 1)
        };

        // Make prediction
        const output = net.run(input);

        // Denormalize the result
        const prediction = denormalizeValue(output.priceChange, -10, 10);

        // Calculate confidence bounds (95% confidence interval)
        const lowerBound = prediction - 1.96 * stdDev;
        const upperBound = prediction + 1.96 * stdDev;

        // Calculate confidence score (0-100%)
        // Higher absolute prediction with lower stdDev = higher confidence
        const confidenceScore = Math.min(100, Math.max(0,
            (Math.abs(prediction) / (stdDev + 0.5)) * 50
        ));

        return {
            prediction,
            lowerBound,
            upperBound,
            confidenceInterval,
            confidenceScore,
            stdDev
        };
    } catch (error) {
        log(`Error predicting with Brain.js: ${error.message}`, 'error', error);
        return null;
    }
}

// Get model performance statistics
function getModelPerformance(symbol) {
    try {
        if (!validateSymbol(symbol)) {
            return null;
        }

        // Try to get performance from latest version first
        const modelDir = path.join(MODEL_PATH, symbol);
        const latestPath = path.join(modelDir, 'latest');

        let performancePath;

        if (fs.existsSync(latestPath)) {
            performancePath = path.join(latestPath, 'performance.json');
        } else {
            performancePath = path.join(modelDir, 'performance.json');
        }

        if (!fs.existsSync(performancePath)) {
            return null;
        }

        return JSON.parse(fs.readFileSync(performancePath, 'utf8'));
    } catch (error) {
        log(`Error getting model performance: ${error.message}`, 'error', error);
        return null;
    }
}

// Get all model versions for a symbol
function getModelVersions(symbol) {
    try {
        if (!validateSymbol(symbol)) {
            return [];
        }

        const modelDir = path.join(MODEL_PATH, symbol);

        if (!fs.existsSync(modelDir)) {
            return [];
        }

        // Get all directories that start with 'v'
        const versions = fs.readdirSync(modelDir)
            .filter(item => 
                fs.statSync(path.join(modelDir, item)).isDirectory() &&
                item.startsWith('v') &&
                fs.existsSync(path.join(modelDir, item, 'model.json'))
            )
            .map(version => {
                const performancePath = path.join(modelDir, version, 'performance.json');
                let performance = null;

                if (fs.existsSync(performancePath)) {
                    performance = JSON.parse(fs.readFileSync(performancePath, 'utf8'));
                }

                return {
                    version: version.substring(1), // Remove 'v' prefix
                    performance
                };
            })
            .sort((a, b) => {
                // Sort by date (newest first)
                try {
                    return new Date(b.version) - new Date(a.version);
                } catch (error) {
                    return 0;
                }
            });

        return versions;
    } catch (error) {
        log(`Error getting model versions for ${symbol}: ${error.message}`, 'error', error);
        return [];
    }
}

// Compare two model versions (A/B testing)
async function compareModelVersions(symbol, versionA, versionB) {
    try {
        if (!validateSymbol(symbol)) {
            return null;
        }

        // Load data for testing
        const data = await loadSymbolData(symbol);
        if (data.length < 50) {
            log(`Not enough data for ${symbol} to compare models`, 'warning');
            return null;
        }

        // Prepare test data
        const testData = data.map(d => ({
            input: {
                ema_diff: normalizeValue(d.ema_diff, -10, 10),
                rsi: normalizeValue(d.rsi, 0, 100),
                macd: normalizeValue(d.macd_hist, -1, 1),
                bbWidth: normalizeValue(d.bb_width, 0, 0.1),
                volume: normalizeValue(d.volume, 0, 1000000000),
                volumeChange: normalizeValue(d.volume_change, -1, 1),
                atr: normalizeValue(d.atr, 0, 1)
            },
            expected: d.future_price_change
        }));

        // Load models
        const modelDirA = path.join(MODEL_PATH, symbol, `v${versionA}`);
        const modelDirB = path.join(MODEL_PATH, symbol, `v${versionB}`);

        if (!fs.existsSync(modelDirA) || !fs.existsSync(modelDirB)) {
            log(`One or both model versions not found for ${symbol}`, 'error');
            return null;
        }

        const modelJsonA = JSON.parse(fs.readFileSync(path.join(modelDirA, 'model.json'), 'utf8'));
        const modelJsonB = JSON.parse(fs.readFileSync(path.join(modelDirB, 'model.json'), 'utf8'));

        // Load hyperparameters if available
        let hyperparamsA = null, hyperparamsB = null;

        const hyperparamsPathA = path.join(modelDirA, 'hyperparams.json');
        const hyperparamsPathB = path.join(modelDirB, 'hyperparams.json');

        if (fs.existsSync(hyperparamsPathA)) {
            hyperparamsA = JSON.parse(fs.readFileSync(hyperparamsPathA, 'utf8'));
        }

        if (fs.existsSync(hyperparamsPathB)) {
            hyperparamsB = JSON.parse(fs.readFileSync(hyperparamsPathB, 'utf8'));
        }

        // Create neural networks
        const netA = createModel(hyperparamsA);
        const netB = createModel(hyperparamsB);

        netA.fromJSON(modelJsonA);
        netB.fromJSON(modelJsonB);

        // Test both models
        const resultsA = testData.map(item => {
            const output = netA.run(item.input);
            const prediction = denormalizeValue(output.priceChange, -10, 10);
            return {
                prediction,
                expected: item.expected,
                error: Math.abs(prediction - item.expected),
                correctDirection: (prediction > 0 && item.expected > 0) || (prediction < 0 && item.expected < 0)
            };
        });

        const resultsB = testData.map(item => {
            const output = netB.run(item.input);
            const prediction = denormalizeValue(output.priceChange, -10, 10);
            return {
                prediction,
                expected: item.expected,
                error: Math.abs(prediction - item.expected),
                correctDirection: (prediction > 0 && item.expected > 0) || (prediction < 0 && item.expected < 0)
            };
        });

        // Calculate metrics
        const maeA = resultsA.reduce((sum, r) => sum + r.error, 0) / resultsA.length;
        const maeB = resultsB.reduce((sum, r) => sum + r.error, 0) / resultsB.length;

        const dirAccA = resultsA.filter(r => r.correctDirection).length / resultsA.length;
        const dirAccB = resultsB.filter(r => r.correctDirection).length / resultsB.length;

        // Calculate confidence intervals
        const predictionsA = resultsA.map(r => r.prediction);
        const predictionsB = resultsB.map(r => r.prediction);
        const actual = testData.map(item => item.expected);

        const ciStatsA = calculateConfidenceInterval(predictionsA, actual);
        const ciStatsB = calculateConfidenceInterval(predictionsB, actual);

        // Determine winner
        // We prioritize direction accuracy, but also consider MAE
        const scoreA = dirAccA - (maeA * 0.1);
        const scoreB = dirAccB - (maeB * 0.1);

        const winner = scoreA > scoreB ? 'A' : 'B';
        const improvement = Math.abs((scoreA - scoreB) / Math.min(scoreA, scoreB)) * 100;

        return {
            versionA: {
                version: versionA,
                mae: maeA,
                directionAccuracy: dirAccA,
                confidenceInterval: ciStatsA.confidenceInterval,
                stdDev: ciStatsA.stdDev,
                score: scoreA
            },
            versionB: {
                version: versionB,
                mae: maeB,
                directionAccuracy: dirAccB,
                confidenceInterval: ciStatsB.confidenceInterval,
                stdDev: ciStatsB.stdDev,
                score: scoreB
            },
            winner,
            improvement: improvement.toFixed(2) + '%',
            testSamples: testData.length
        };
    } catch (error) {
        log(`Error comparing model versions for ${symbol}: ${error.message}`, 'error', error);
        return null;
    }
}

// Ensemble prediction using multiple model versions
async function ensemblePrediction(symbol, features) {
    try {
        if (!validateSymbol(symbol) || !validateFeatures(features)) {
            return null;
        }
        
        const modelDir = path.join(MODEL_PATH, symbol);
        if (!fs.existsSync(modelDir)) {
            return null;
        }
        
        // Get all model versions
        const versions = fs.readdirSync(modelDir)
            .filter(item => 
                fs.statSync(path.join(modelDir, item)).isDirectory() &&
                item.startsWith('v') &&
                fs.existsSync(path.join(modelDir, item, 'model.json'))
            )
            .slice(0, 5); // Use up to 5 most recent versions
        
        if (versions.length === 0) {
            return null;
        }
        
        // Make predictions with each model
        const predictions = [];
        
        for (const version of versions) {
            const modelPath = path.join(modelDir, version, 'model.json');
            const featuresPath = path.join(modelDir, version, 'features.json');
            
            if (!fs.existsSync(modelPath) || !fs.existsSync(featuresPath)) {
                continue;
            }
            
            // Load model
            const modelJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
            const featureNames = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
            
            // Create neural network
            const net = createModel();
            net.fromJSON(modelJson);
            
            // Normalize input features
            const input = {
                ema_diff: normalizeValue(features.priceDiff, -10, 10),
                rsi: normalizeValue(features.rsi, 0, 100),
                macd: normalizeValue(features.macdHist, -1, 1),
                bbWidth: normalizeValue(features.bbWidth, 0, 0.1),
                volume: normalizeValue(features.volume24h, 0, 1000000000),
                volumeChange: normalizeValue(features.volumeChange, -1, 1),
                atr: normalizeValue(features.atr, 0, 1)
            };
            
            // Make prediction
            const output = net.run(input);
            
            // Denormalize price change prediction
            const prediction = denormalizeValue(output.priceChange, -10, 10);
            
            predictions.push(prediction);
        }
        
        if (predictions.length === 0) {
            return null;
        }
        
        // Calculate ensemble prediction (weighted average)
        // More recent models get higher weight
        let weightedSum = 0;
        let weightSum = 0;
        
        for (let i = 0; i < predictions.length; i++) {
            const weight = predictions.length - i; // Newer models get higher weight
            weightedSum += predictions[i] * weight;
            weightSum += weight;
        }
        
        const ensemblePrediction = weightedSum / weightSum;
        
        // Calculate confidence based on prediction agreement
        // If predictions are similar, confidence is higher
        const variance = predictions.reduce((sum, pred) => 
            sum + Math.pow(pred - ensemblePrediction, 2), 0) / predictions.length;
        
        const stdDev = Math.sqrt(variance);
        const agreement = Math.max(0, 1 - (stdDev / Math.abs(ensemblePrediction)));
        
        // Calculate confidence score (0-100)
        const confidenceScore = Math.min(100, Math.max(0, agreement * 100));
        
        return {
            prediction: ensemblePrediction,
            confidence: confidenceScore / 100, // Normalize to 0-1
            individualPredictions: predictions,
            stdDev: stdDev,
            modelCount: predictions.length
        };
    } catch (error) {
        log(`Error making ensemble prediction for ${symbol}: ${error.message}`, 'error', error);
        return null;
    }
}

// Train all models
async function trainAllModels() {
    try {
        // Get all symbols with CSV data
        const symbols = fs.readdirSync(CSV_DATA_DIR)
            .filter(item => {
                try {
                    return fs.statSync(path.join(CSV_DATA_DIR, item)).isDirectory();
                } catch (error) {
                    return false;
                }
            });

        if (symbols.length === 0) {
            log('No symbols found with CSV data', 'warning');
            return [];
        }

        log(`Training models for ${symbols.length} symbols`, 'info');

        const results = [];

        for (const symbol of symbols) {
            // Check memory usage before training each model
            if (!checkMemoryUsage()) {
                log(`Skipping remaining models due to high memory usage`, 'warning');
                break;
            }

            const result = await trainModelForSymbol(symbol);
            if (result) {
                results.push({
                    symbol,
                    performance: result.performance,
                    version: result.version
                });
            }
        }

        log(`Completed training ${results.length}/${symbols.length} models`, 'success');
        return results;
    } catch (error) {
        log(`Error training all models: ${error.message}`, 'error', error);
        return [];
    }
}

// Export functions
module.exports = {
    trainModelForSymbol,
    predictPriceChange,
    exportToCSV,
    loadSymbolData,
    getModelPerformance,
    trainAllModels,
    getModelVersions,
    compareModelVersions,
    ensemblePrediction,
    analyzeFeatureImportance
};
