/**
 * 🚀 PŘÍKLAD AUTOMATICKÉHO NAČÍTÁNÍ KOMPRESOVANÝCH DAT
 * 
 * Tento kód automaticky vybere nejlepší dostupný formát:
 * 1. Pokud existuje .br (brotli) → použije to (79% úspora)
 * 2. Pokud existuje .gz (gzip) → použije to (69% úspora)  
 * 3. Jinak použije původní .json
 * 
 * FUNGUJE STEJNĚ JAKO PŮVODNÍ KÓD!
 */

// ===== VERZE 1: Pro Node.js / serverové aplikace =====
import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

export async function loadCsfdDataAuto(basePath = './data/csfd_ratings.json') {
    const brotliPath = basePath + '.br';
    const gzipPath = basePath + '.gz';
    
    try {
        // 1. Zkus brotli (nejmenší)
        if (fs.existsSync(brotliPath)) {
            console.log('📦 Načítám brotli verzi (79% úspora)...');
            const compressed = fs.readFileSync(brotliPath);
            const decompressed = await brotliDecompress(compressed);
            return JSON.parse(decompressed.toString());
        }
        
        // 2. Zkus gzip 
        if (fs.existsSync(gzipPath)) {
            console.log('📦 Načítám gzip verzi (69% úspora)...');
            const compressed = fs.readFileSync(gzipPath);
            const decompressed = await gunzip(compressed);
            return JSON.parse(decompressed.toString());
        }
        
        // 3. Fallback na původní
        console.log('📄 Načítám původní JSON...');
        return JSON.parse(fs.readFileSync(basePath, 'utf8'));
        
    } catch (error) {
        console.error('❌ Chyba při načítání dat:', error);
        throw error;
    }
}

// ===== VERZE 2: Pro webové aplikace (fetch) =====
export async function loadCsfdDataWeb(baseUrl = '/api/csfd-data') {
    try {
        // Fetch s podporou komprese - prohlížeč automaticky dekompresuje!
        const response = await fetch(baseUrl, {
            headers: {
                'Accept-Encoding': 'br, gzip, deflate',
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Automatická dekomprese!
        const data = await response.json();
        
        // Logování úspory
        const contentEncoding = response.headers.get('content-encoding');
        if (contentEncoding === 'br') {
            console.log('📦 Načteno přes brotli (79% úspora)');
        } else if (contentEncoding === 'gzip') {
            console.log('📦 Načteno přes gzip (69% úspora)');  
        } else {
            console.log('📄 Načteno bez komprese');
        }
        
        return data;
        
    } catch (error) {
        console.error('❌ Chyba při načítání dat:', error);
        throw error;
    }
}

// ===== VERZE 3: Pro Next.js API routes =====
export function createCsfdApiHandler(dataPath = './data/csfd_ratings.json') {
    return async function handler(req, res) {
        try {
            const data = await loadCsfdDataAuto(dataPath);
            
            // Automatická komprese odpovědi
            res.setHeader('Content-Type', 'application/json');
            
            // Next.js automaticky aplikuje gzip/brotli pokud to klient podporuje
            res.status(200).json(data);
            
        } catch (error) {
            console.error('API Error:', error);
            res.status(500).json({ error: 'Failed to load CSFD data' });
        }
    };
}

// ===== UKÁZKA POUŽITÍ =====
async function demo() {
    console.log('🧪 Demo automatického načítání...\n');
    
    // Serverová aplikace
    try {
        const data = await loadCsfdDataAuto();
        console.log(`✅ Načteno ${data.length} filmů\n`);
    } catch (error) {
        console.log('⚠️ Lokální soubory nenalezeny, zkusím web demo...\n');
    }
    
    // Web aplikace (simulace)
    console.log('📝 Pro webovou aplikaci použijte:');
    console.log(`
    import { loadCsfdDataWeb } from './auto_load_example.js';
    
    // Automatické načtení s nejlepší kompresí
    const csfdData = await loadCsfdDataWeb('/api/csfd-data');
    
    // Váš existující kód zůstává stejný!
    const filmy2023 = csfdData.filter(film => film.year === '2023');
    `);
}

// Spusť demo při přímém volání
if (import.meta.url === `file://${process.argv[1]}`) {
    demo();
}
