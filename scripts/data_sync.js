const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// Path configurations
const sourceDir = 'C:\\Users\\91629\\Dropbox\\PC\\Desktop\\TRY_PART\\ema tracker\\data';
const destDir = path.join(__dirname, 'csv_data');

// Create destination directory if it doesn't exist
if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

// Initialize watcher
const watcher = chokidar.watch(sourceDir, {
    persistent: true,
    ignoreInitial: false
});

// Function to convert JSON to CSV format
function jsonToCSV(jsonData) {
    if (!Array.isArray(jsonData)) {
        return '';
    }
    
    const headers = Object.keys(jsonData[0] || {});
    const csvRows = [headers.join(',')];
    
    jsonData.forEach(row => {
        const values = headers.map(header => {
            const val = row[header];
            return `"${val}"`;
        });
        csvRows.push(values.join(','));
    });
    
    return csvRows.join('\n');
}

// Function to process JSON file
function processJsonFile(filePath) {
    try {
        const jsonData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const fileName = path.basename(filePath, '.json');
        const csvFilePath = path.join(destDir, `${fileName}.csv`);
        
        const csvContent = jsonToCSV(jsonData);
        fs.writeFileSync(csvFilePath, csvContent, 'utf8');
        
        console.log(`Processed ${fileName}: JSON -> CSV`);
    } catch (error) {
        console.error(`Error processing file ${filePath}:`, error);
    }
}

// Watch for changes
watcher
    .on('add', filePath => {
        if (path.extname(filePath) === '.json') {
            console.log(`New JSON file detected: ${filePath}`);
            processJsonFile(filePath);
        }
    })
    .on('change', filePath => {
        if (path.extname(filePath) === '.json') {
            console.log(`JSON file changed: ${filePath}`);
            processJsonFile(filePath);
        }
    });

console.log(`Watching for JSON files in ${sourceDir}`);