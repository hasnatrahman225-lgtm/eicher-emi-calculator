const fs = require('fs');
const xlsx = require('xlsx');

const workbook = xlsx.readFile('../Price calculator.xlsx');
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const data = xlsx.utils.sheet_to_json(worksheet);

let newModelData = "    const modelData = {\n";

for (const row of data) {
    if (row['__EMPTY_3'] && typeof row['__EMPTY_3'] === 'number') {
        const mrp = row['__EMPTY_3'];
        const regCost = row['__EMPTY_4'] || 0;
        const processingFee = row['__EMPTY_5'] || 0;
        const cp12 = row['__EMPTY_7'] || null;
        const cp24 = row['__EMPTY_8'] || null;
        const cp29 = row['__EMPTY_9'] || null;
        const cp35 = row['__EMPTY_10'] || null;
        const dp = row['__EMPTY_11'] || 0;
        
        newModelData += `        "${mrp}": { cp12: ${cp12 ? Math.round(cp12) : null}, cp24: ${cp24 ? Math.round(cp24) : null}, cp29: ${cp29 ? Math.round(cp29) : null}, cp35: ${cp35 ? Math.round(cp35) : null}, dp: ${dp}, regCost: ${Math.round(regCost)}, processingFee: ${Math.round(processingFee)} },\n`;
    }
}
newModelData += "    };";

console.log(newModelData);

// Now read index.html and replace it
let html = fs.readFileSync('public/index.html', 'utf8');
const regex = /const modelData = \{[\s\S]*?\};\n/g;
html = html.replace(regex, newModelData + "\n");
fs.writeFileSync('public/index.html', html);
console.log("Updated public/index.html");
