/**
 * Technical indicators module for financial analysis
 * Provides functions to calculate various technical indicators with proper validation
 */

// Utility function to validate price data
function validatePriceData(prices, minLength = 1, functionName = '') {
    if (!Array.isArray(prices)) {
      throw new Error(`${functionName}: Prices must be an array`);
    }
    
    if (prices.length < minLength) {
      return false;
    }
    
    // Check if all elements are valid numbers
    const hasInvalidValues = prices.some(price => 
      price === null || price === undefined || isNaN(Number(price))
    );
    
    if (hasInvalidValues) {
      throw new Error(`${functionName}: All prices must be valid numbers`);
    }
    
    return true;
  }
  
  // Utility function to pad arrays with a default value
  function padArray(array, targetLength, padValue, padStart = true) {
    if (array.length >= targetLength) return array;
    
    const padding = Array(targetLength - array.length).fill(padValue);
    return padStart ? padding.concat(array) : array.concat(padding);
  }
  
  /**
   * Calculate Relative Strength Index (RSI)
   * @param {Array<number>} prices - Array of price values
   * @param {number} period - RSI period
   * @returns {Array<number>} RSI values
   */
  function calculateRSI(prices, period = 14) {
    const functionName = 'calculateRSI';
    
    // Validate inputs
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error(`${functionName}: Period must be a positive integer`);
    }
    
    if (!validatePriceData(prices, period + 1, functionName)) {
      return padArray([], prices.length, 50, true);
    }
    
    try {
      const changes = [];
      for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i] - prices[i - 1]);
      }
      
      const rsiValues = [];
      
      // Calculate first RSI
      let gains = 0;
      let losses = 0;
      
      for (let i = 0; i < period; i++) {
        if (changes[i] >= 0) {
          gains += changes[i];
        } else {
          losses -= changes[i];
        }
      }
      
      // Avoid division by zero
      if (losses === 0) {
        rsiValues.push(100);
      } else {
        const rs = gains / losses;
        rsiValues.push(100 - (100 / (1 + rs)));
      }
      
      // Calculate remaining RSI values
      for (let i = period; i < changes.length; i++) {
        // Update gains and losses with smoothing
        if (changes[i] >= 0) {
          gains = (gains * (period - 1) + changes[i]) / period;
          losses = (losses * (period - 1)) / period;
        } else {
          gains = (gains * (period - 1)) / period;
          losses = (losses * (period - 1) - changes[i]) / period;
        }
        
        // Avoid division by zero
        if (losses === 0) {
          rsiValues.push(100);
        } else {
          const rs = gains / losses;
          rsiValues.push(100 - (100 / (1 + rs)));
        }
      }
      
      // Pad the beginning with 50 (neutral) values
      return padArray(rsiValues, prices.length, 50, true);
    } catch (error) {
      throw new Error(`${functionName}: ${error.message}`);
    }
  }
  
  /**
   * Calculate Bollinger Bands
   * @param {Array<number>} prices - Array of price values
   * @param {number} period - Period for SMA calculation
   * @param {number} multiplier - Standard deviation multiplier
   * @returns {Object} Object containing upper, middle, and lower bands
   */
  function calculateBollingerBands(prices, period = 20, multiplier = 2) {
    const functionName = 'calculateBollingerBands';
    
    // Validate inputs
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error(`${functionName}: Period must be a positive integer`);
    }
    
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(`${functionName}: Multiplier must be a positive number`);
    }
    
    if (!validatePriceData(prices, period, functionName)) {
      const defaultValue = prices.length > 0 ? prices[0] : 0;
      return {
        upper: Array(prices.length).fill(defaultValue * 1.1),
        middle: Array(prices.length).fill(defaultValue),
        lower: Array(prices.length).fill(defaultValue * 0.9)
      };
    }
    
    try {
      const middle = [];
      const upper = [];
      const lower = [];
      
      // Calculate SMA and Bollinger Bands
      for (let i = period - 1; i < prices.length; i++) {
        // Calculate SMA
        let sum = 0;
        for (let j = i - (period - 1); j <= i; j++) {
          sum += prices[j];
        }
        const sma = sum / period;
        
        // Calculate standard deviation
        let sumSquaredDiff = 0;
        for (let j = i - (period - 1); j <= i; j++) {
          sumSquaredDiff += Math.pow(prices[j] - sma, 2);
        }
        const stdDev = Math.sqrt(sumSquaredDiff / period);
        
        // Calculate bands
        middle.push(sma);
        upper.push(sma + (multiplier * stdDev));
        lower.push(sma - (multiplier * stdDev));
      }
      
      // Default value for padding
      const defaultValue = prices.length > 0 ? prices[0] : 0;
      
      // Pad the beginning
      return {
        upper: padArray(upper, prices.length, defaultValue * 1.1, true),
        middle: padArray(middle, prices.length, defaultValue, true),
        lower: padArray(lower, prices.length, defaultValue * 0.9, true)
      };
    } catch (error) {
      throw new Error(`${functionName}: ${error.message}`);
    }
  }
  
  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   * @param {Array<number>} prices - Array of price values
   * @param {number} fastPeriod - Fast EMA period
   * @param {number} slowPeriod - Slow EMA period
   * @param {number} signalPeriod - Signal line period
   * @returns {Object} Object containing MACD line, signal line, and histogram
   */
  function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const functionName = 'calculateMACD';
    
    // Validate inputs
    if (!Number.isInteger(fastPeriod) || fastPeriod <= 0) {
      throw new Error(`${functionName}: Fast period must be a positive integer`);
    }
    
    if (!Number.isInteger(slowPeriod) || slowPeriod <= 0) {
      throw new Error(`${functionName}: Slow period must be a positive integer`);
    }
    
    if (!Number.isInteger(signalPeriod) || signalPeriod <= 0) {
      throw new Error(`${functionName}: Signal period must be a positive integer`);
    }
    
    if (!validatePriceData(prices, Math.max(fastPeriod, slowPeriod), functionName)) {
      return {
        macd: Array(prices.length).fill(0),
        signal: Array(prices.length).fill(0),
        histogram: Array(prices.length).fill(0)
      };
    }
    
    try {
      // Calculate Exponential Moving Averages
      const fastEMA = calculateEMA(prices, fastPeriod);
      const slowEMA = calculateEMA(prices, slowPeriod);
      
      // Calculate MACD line
      const macdLine = [];
      for (let i = 0; i < prices.length; i++) {
        if (i < slowPeriod - 1) {
          macdLine.push(0); // Not enough data yet
        } else {
          macdLine.push(fastEMA[i] - slowEMA[i]);
        }
      }
      
      // Calculate Signal line (EMA of MACD line)
      const signalLine = calculateEMA(macdLine, signalPeriod);
      
      // Calculate Histogram
      const histogram = [];
      for (let i = 0; i < macdLine.length; i++) {
        if (i < slowPeriod + signalPeriod - 2) {
          histogram.push(0); // Not enough data yet
        } else {
          histogram.push(macdLine[i] - signalLine[i]);
        }
      }
      
      return {
        macd: macdLine,
        signal: signalLine,
        histogram: histogram
      };
    } catch (error) {
      throw new Error(`${functionName}: ${error.message}`);
    }
  }
  
  /**
   * Calculate EMA (Exponential Moving Average)
   * @param {Array<number>} prices - Array of price values
   * @param {number} period - EMA period
   * @returns {Array<number>} EMA values
   */
  function calculateEMA(prices, period) {
    const functionName = 'calculateEMA';
    
    // Validate inputs
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error(`${functionName}: Period must be a positive integer`);
    }
    
    if (!validatePriceData(prices, period, functionName)) {
      return padArray([], prices.length, prices.length > 0 ? prices[0] : 0, true);
    }
    
    try {
      const k = 2 / (period + 1);
      const emaValues = [];
      
      // Start with SMA for the first EMA value
      let sum = 0;
      for (let i = 0; i < period; i++) {
        sum += prices[i];
      }
      
      let ema = sum / period;
      emaValues.push(ema);
      
      // Calculate remaining EMA values
      for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * k + ema;
        emaValues.push(ema);
      }
      
      // Pad the beginning with the first price
      return padArray(emaValues, prices.length, prices[0], true);
    } catch (error) {
      throw new Error(`${functionName}: ${error.message}`);
    }
  }
  
  /**
   * Calculate Average True Range (ATR)
   * @param {Array<Object>} klines - Array of kline objects with high, low, close properties
   * @param {number} period - ATR period
   * @returns {number} ATR value
   */
  function calculateATR(klines, period = 14) {
    const functionName = 'calculateATR';
    
    // Validate inputs
    if (!Number.isInteger(period) || period <= 0) {
      throw new Error(`${functionName}: Period must be a positive integer`);
    }
    
    if (!Array.isArray(klines)) {
      throw new Error(`${functionName}: Klines must be an array`);
    }
    
    if (klines.length < period + 1) {
      return 0;
    }
    
    // Validate kline objects
    for (let i = 0; i < klines.length; i++) {
      const kline = klines[i];
      if (!kline || typeof kline !== 'object') {
        throw new Error(`${functionName}: Each kline must be an object`);
      }
      
      if (isNaN(Number(kline.high)) || isNaN(Number(kline.low)) || isNaN(Number(kline.close))) {
        throw new Error(`${functionName}: Kline at index ${i} has invalid high, low, or close value`);
      }
    }
    
    try {
      const trueRanges = [];
  
      // Calculate True Range for each candle
      for (let i = 1; i < klines.length; i++) {
        const high = Number(klines[i].high);
        const low = Number(klines[i].low);
        const prevClose = Number(klines[i - 1].close);
  
        // True Range is the greatest of:
        // 1. Current High - Current Low
        // 2. |Current High - Previous Close|
        // 3. |Current Low - Previous Close|
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
  
        const trueRange = Math.max(tr1, tr2, tr3);
        trueRanges.push(trueRange);
      }
  
      // Calculate ATR (simple average of true ranges)
      if (trueRanges.length < period) {
        return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
      }
  
      // Use the last 'period' true ranges
      const recentTrueRanges = trueRanges.slice(-period);
      return recentTrueRanges.reduce((sum, tr) => sum + tr, 0) / period;
    } catch (error) {
      throw new Error(`${functionName}: ${error.message}`);
    }
  }
  
  module.exports = {
    calculateRSI,
    calculateMACD,
    calculateBollingerBands,
    calculateEMA,
    calculateATR,
    // Export utility functions for testing
    validatePriceData,
    padArray
  };
  