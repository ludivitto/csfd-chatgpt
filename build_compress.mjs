#!/usr/bin/env node
/**
 * Build skript pro kompresí ČSFD dat
 * Spustit před nasazením: node build_compress.mjs
 */

import { precompressFiles } from './compression_guide.mjs';
import fs from 'fs';

const INPUT_FILE = './data/csfd_ratings.json';
const OUTPUT_DIR = './dist/';

console.log('🚀 Spouštím build proces...');

// Vytvoř output adresář
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Prekompresuj soubory
await precompressFiles(INPUT_FILE, OUTPUT_DIR);

console.log(`✅ Hotovo! Soubory uloženy do ${OUTPUT_DIR}:`);
console.log('   - csfd_ratings.json (původní)');
console.log('   - csfd_ratings.json.gz (gzip)');
console.log('   - csfd_ratings.json.br (brotli)');
console.log('\n💡 Pro produkci použijte brotli verzi (.br) s fallbackem na gzip (.gz)');
