// Install TensorFlow.js
// npm install @tensorflow/tfjs-node

//const tf = require('@tensorflow/tfjs-node');

// Create a simple price direction prediction model
async function createModel() {
    // Sequential model
    const model = tf.sequential();
    
    // Add layers
    model.add(tf.layers.dense({
        inputShape: [10], // Number of features
        units: 32,
        activation: 'relu'
    }));
    
    model.add(tf.layers.dropout({ rate: 0.2 }));
    
    model.add(tf.layers.dense({
        units: 16,
        activation: 'relu'
    }));
    
    model.add(tf.layers.dense({
        units: 1,
        activation: 'sigmoid' // Binary classification (up/down)
    }));
    
    // Compile the model
    model.compile({
        optimizer: 'adam',
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
    });
    
    return model;
}

// Train model for a specific symbol
async function trainModel(symbol) {
    try {
        // Get training data for this symbol
        const data = trainingData.get(symbol);
        if (!data || data.length < 100) {
            log(`Not enough data to train model for ${symbol}`, 'warning');
            return null;
        }
        
        // Prepare features and labels
        const features = data.slice(0, -1).map(d => [
            d.ema_diff,
            d.volume,
            // Add other indicators from calculateIndicators
            d.rsi / 100, // Normalize RSI
            d.macd,
            (d.close - d.bollingerBands.lower) / (d.bollingerBands.upper - d.bollingerBands.lower), // Normalized BB position
            d.volumeChange,
            d.close / d.open - 1, // Candle body
            (d.high - Math.max(d.open, d.close)) / d.close, // Upper wick
            (Math.min(d.open, d.close) - d.low) / d.close, // Lower wick
            d.close / d.ema - 1 // Normalized distance from EMA
        ]);
        
        // Labels: 1 if price went up in next candle, 0 if down
        const labels = data.slice(1).map((d, i) => d.close > data[i].close ? 1 : 0);
        
        // Convert to tensors
        const xs = tf.tensor2d(features);
        const ys = tf.tensor2d(labels, [labels.length, 1]);
        
        // Create and train model
        const model = await createModel();
        
        // Train the model
        await model.fit(xs, ys, {
            epochs: 50,
            batchSize: 32,
            validationSplit: 0.2,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    fs.appendFileSync(
                        path.join(LOG_DIR, `ml-training-${new Date().toISOString().split('T')[0]}.log`),
                        `[${new Date().toISOString()}] ${symbol} - Epoch ${epoch}: loss=${logs.loss.toFixed(4)}, accuracy=${logs.acc.toFixed(4)}\n`
                    );
                }
            }
        });
        
        // Save model for this symbol
        const modelSavePath = path.join(__dirname, 'models', symbol);
        if (!fs.existsSync(path.join(__dirname, 'models'))) {
            fs.mkdirSync(path.join(__dirname, 'models'));
        }
        
        await model.save(`file://${modelSavePath}`);
        log(`Model trained and saved for ${symbol}`, 'success');
        
        return model;
    } catch (error) {
        log(`Error training model for ${symbol}: ${error.message}`, 'error');
        return null;
    }
}
// Predict price direction for a specific symbol