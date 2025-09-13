/**
 * Praktický návod pro implementaci komprese ČSFD JSON dat
 * Zachovává původní strukturu - nerozbije existující aplikaci!
 */

import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

// ===== SERVEROVÝ PŘÍSTUP =====

/**
 * Funkce pro automatické posílání kompresovaných dat
 * Použití s Express.js, Next.js, atd.
 */
export async function serveCompressedJson(req, res, jsonFilePath) {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    
    try {
        // Načti původní JSON
        const jsonData = fs.readFileSync(jsonFilePath, 'utf8');
        
        // Brotli komprese (nejlepší)
        if (acceptEncoding.includes('br')) {
            const compressed = await brotliCompress(jsonData);
            res.set({
                'Content-Encoding': 'br',
                'Content-Type': 'application/json',
                'Content-Length': compressed.length
            });
            return res.send(compressed);
        }
        
        // Gzip komprese (fallback)
        if (acceptEncoding.includes('gzip')) {
            const compressed = await gzip(jsonData);
            res.set({
                'Content-Encoding': 'gzip',
                'Content-Type': 'application/json',
                'Content-Length': compressed.length
            });
            return res.send(compressed);
        }
        
        // Nekompresovaný fallback
        res.set('Content-Type', 'application/json');
        res.send(jsonData);
        
    } catch (error) {
        res.status(500).json({ error: 'Failed to serve JSON data' });
    }
}

// ===== KLIENTSKÝ PŘÍSTUP =====

/**
 * Funkce pro načtení dat s automatickou dekompresí
 * Funguje transparentně - vrací stejná data jako původní JSON
 */
export async function loadCsfdData(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'Accept-Encoding': 'br, gzip, deflate'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // Fetch automaticky dekompresuje podle Content-Encoding header
        const jsonData = await response.json();
        
        console.log(`✅ Načteno ${jsonData.length} záznamů`);
        return jsonData;
        
    } catch (error) {
        console.error('❌ Chyba při načítání dat:', error);
        throw error;
    }
}

// ===== BUILD PROCES =====

/**
 * Skript pro prekompresování souborů při buildu
 * Spusťte před nasazením aplikace
 */
export async function precompressFiles(inputFile, outputDir = './dist/') {
    try {
        const jsonData = fs.readFileSync(inputFile, 'utf8');
        const jsonSize = Buffer.byteLength(jsonData, 'utf8');
        
        // Zkopíruj původní soubor
        fs.copyFileSync(inputFile, `${outputDir}/csfd_ratings.json`);
        
        // Vytvoř gzip verzi
        const gzipData = await gzip(jsonData);
        fs.writeFileSync(`${outputDir}/csfd_ratings.json.gz`, gzipData);
        
        // Vytvoř brotli verzi
        const brotliData = await brotliCompress(jsonData);
        fs.writeFileSync(`${outputDir}/csfd_ratings.json.br`, brotliData);
        
        // Statistiky
        console.log('📊 Výsledky komprese:');
        console.log(`   Původní: ${Math.round(jsonSize / 1024)}KB`);
        console.log(`   Gzip: ${Math.round(gzipData.length / 1024)}KB (${Math.round((1 - gzipData.length / jsonSize) * 100)}% úspora)`);
        console.log(`   Brotli: ${Math.round(brotliData.length / 1024)}KB (${Math.round((1 - brotliData.length / jsonSize) * 100)}% úspora)`);
        
    } catch (error) {
        console.error('❌ Chyba při kompresování:', error);
    }
}

// ===== NGINX KONFIGURACE =====
export const nginxConfig = `
# Automatická komprese pro JSON soubory
location ~* \.json$ {
    gzip on;
    gzip_types application/json text/plain;
    gzip_min_length 1000;
    
    # Brotli podpora (pokud máte modul)
    brotli on;
    brotli_types application/json text/plain;
    brotli_min_length 1000;
    
    add_header Cache-Control "public, max-age=3600";
}
`;

// ===== UKÁZKY POUŽITÍ =====

// 1. Pro lokální vývoj (dekomprese local souborů)
export async function loadLocalCompressed(filePath) {
    if (filePath.endsWith('.br')) {
        const compressed = fs.readFileSync(filePath);
        const decompressed = await brotliDecompress(compressed);
        return JSON.parse(decompressed.toString());
    }
    
    if (filePath.endsWith('.gz')) {
        const compressed = fs.readFileSync(filePath);
        const decompressed = await gunzip(compressed);
        return JSON.parse(decompressed.toString());
    }
    
    // Normální JSON
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// 2. Express middleware
export function compressionMiddleware(req, res, next) {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    
    // Preferuj brotli, pak gzip
    if (acceptEncoding.includes('br')) {
        req.preferredCompression = 'br';
    } else if (acceptEncoding.includes('gzip')) {
        req.preferredCompression = 'gzip';
    }
    
    next();
}

// ===== DEMO =====
if (import.meta.url === `file://${process.argv[1]}`) {
    // Prekompresování souborů
    await precompressFiles('./data/csfd_ratings.json', './data/');
    
    // Test načtení kompresovaných dat
    console.log('\n🧪 Test načtení kompresovaných dat:');
    
    const originalData = JSON.parse(fs.readFileSync('./data/csfd_ratings.json', 'utf8'));
    const brotliData = await loadLocalCompressed('./data/csfd_ratings.json.br');
    const gzipData = await loadLocalCompressed('./data/csfd_ratings.json.gz');
    
    console.log('✅ Všechna data jsou identická:', 
        JSON.stringify(originalData) === JSON.stringify(brotliData) &&
        JSON.stringify(originalData) === JSON.stringify(gzipData)
    );
}
