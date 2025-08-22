const fs = require('fs');
const path = require('path');

// Create ML data directory if it doesn't exist
const ML_DATA_DIR = path.join(__dirname, 'ml_data');
if (!fs.existsSync(ML_DATA_DIR)) {
    fs.mkdirSync(ML_DATA_DIR, { recursive: true });
}

// Function to log messages
function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    
    // Console logging with colors
    switch(type) {
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
    
    // File logging
    const LOG_DIR = path.join(__dirname, 'logs');
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR);
    }
    const logFile = path.join(LOG_DIR, `ema-tracker-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, logMessage + '\n');
}

// Collect data point for ML training
async function collectDataPoint(symbol, dataPoint) {
    try {
        // Create directory for this symbol if it doesn't exist
        const symbolDir = path.join(ML_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            fs.mkdirSync(symbolDir, { recursive: true });
        }
        
        // Use current month for filename to organize data
        const date = new Date();
        const filename = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}.json`;
        const filePath = path.join(symbolDir, filename);
        
        // Load existing data or create new array
        let data = [];
        if (fs.existsSync(filePath)) {
            try {
                data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                log(`Error reading data file for ${symbol}: ${e.message}`, 'error');
                // If file is corrupted, start fresh
                data = [];
            }
        }
        
        // Add new data point
        data.push(dataPoint);
        
        // Save data back to file
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        
        // Only log occasionally to avoid excessive logging
        if (data.length % 100 === 0) {
            log(`Collected ${data.length} data points for ${symbol} (${filename})`, 'info');
        }
        
        return true;
    } catch (error) {
        log(`Error collecting data point for ${symbol}: ${error.message}`, 'error');
        return false;
    }
}

// Update future price change for a specific data point
async function updateFuturePriceChange(symbol, timestamp, priceChange) {
    try {
        // Find the file containing this timestamp
        const symbolDir = path.join(ML_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            return false;
        }
        
        const files = fs.readdirSync(symbolDir).filter(f => f.endsWith('.json'));
        
        for (const file of files) {
            const filePath = path.join(symbolDir, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            // Find the data point with matching timestamp
            const index = data.findIndex(d => d.timestamp === timestamp);
            if (index !== -1) {
                // Update the future price change
                data[index].futurePriceChange = priceChange;
                
                // Save the updated data
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                return true;
            }
        }
        
        return false;
    } catch (error) {
        log(`Error updating future price change for ${symbol}: ${error.message}`, 'error');
        return false;
    }
}

// Get all collected data for a symbol
function getSymbolData(symbol) {
    try {
        const symbolDir = path.join(ML_DATA_DIR, symbol);
        if (!fs.existsSync(symbolDir)) {
            return [];
        }
        
        const files = fs.readdirSync(symbolDir).filter(f => f.endsWith('.json'));
        let allData = [];
        
        for (const file of files) {
            const filePath = path.join(symbolDir, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            allData = allData.concat(data);
        }
        
        return allData;
    } catch (error) {
        log(`Error getting data for ${symbol}: ${error.message}`, 'error');
        return [];
    }
}

// Get all symbols with collected data
function getAllSymbols() {
    try {
        if (!fs.existsSync(ML_DATA_DIR)) {
            return [];
        }
        
        return fs.readdirSync(ML_DATA_DIR)
            .filter(item => fs.statSync(path.join(ML_DATA_DIR, item)).isDirectory());
    } catch (error) {
        log(`Error getting all symbols: ${error.message}`, 'error');
        return [];
    }
}

module.exports = {
    collectDataPoint,
    updateFuturePriceChange,
    getSymbolData,
    getAllSymbols
};