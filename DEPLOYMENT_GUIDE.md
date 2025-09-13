# 🚀 Automatický Deployment s kompresí

## ✅ **Nyní je VŠE automatické!**

Po úpravě GitHub Actions se **komprese spustí automaticky** při každém scrapingu:

```yaml
# Automaticky se spustí po scrapingu:
- name: Compress JSON data
  run: node build_compress.mjs

# Automaticky se commitnou kompresované soubory:  
git add data/csfd_ratings.json.gz data/csfd_ratings.json.br
```

---

## 🎯 **Deployment na různé platformy**

### 1. **Vercel** (doporučeno)
```bash
# Automaticky podporuje brotli + gzip ✅
vercel deploy
```

**Žádná konfigurace není potřeba!** Vercel automaticky:
- Detekuje `.json` soubory
- Aplikuje nejlepší kompresi  
- Posílá brotli/gzip podle klienta

### 2. **Netlify**
```bash
# Automaticky podporuje gzip + brotli ✅
netlify deploy
```

Volitelně přidejte do `netlify.toml`:
```toml
[[headers]]
  for = "*.json"
  [headers.values]
    Cache-Control = "public, max-age=3600"
```

### 3. **Next.js** (API Routes)
```javascript
// pages/api/csfd-data.js
import { createCsfdApiHandler } from '../../auto_load_example.js';

export default createCsfdApiHandler('./data/csfd_ratings.json');
```

**Next.js automaticky** aplikuje gzip/brotli!

### 4. **Express.js Server**
```javascript
import express from 'express';
import compression from 'compression';
import { loadCsfdDataAuto } from './auto_load_example.js';

const app = express();

// Automatická komprese všech odpovědí
app.use(compression());

app.get('/api/csfd-data', async (req, res) => {
    const data = await loadCsfdDataAuto('./data/csfd_ratings.json');
    res.json(data); // Automaticky se zkompresuje!
});
```

### 5. **Static hosting** (GitHub Pages, Surge, etc.)
```bash
# Upload všech verzí:
# - csfd_ratings.json (fallback)
# - csfd_ratings.json.gz (gzip)  
# - csfd_ratings.json.br (brotli)

# Server automaticky vybere nejlepší podle Accept-Encoding header
```

---

## 📱 **Klientské aplikace**

### React/Vue/Angular
```javascript
import { loadCsfdDataWeb } from './auto_load_example.js';

// Automatická detekce nejlepší komprese
const data = await loadCsfdDataWeb('/api/csfd-data');

// Váš existující kód funguje stejně!
const filmy = data.filter(film => film.rating >= 4);
```

### Vanilla JavaScript
```javascript
// Prohlížeč automaticky dekompresuje!
const response = await fetch('/data/csfd_ratings.json', {
    headers: { 'Accept-Encoding': 'br, gzip' }
});
const data = await response.json();
```

---

## ⚡ **Automatické optimalizace**

### GitHub Actions workflow:
1. **Scraping** → `csfd_ratings.json` (2.4MB)
2. **Komprese** → `.gz` (745KB) + `.br` (510KB)  
3. **Commit** → všechny verze se commitnou
4. **Deploy** → server automaticky vybere nejlepší

### Server response:
```http
Accept-Encoding: br, gzip, deflate

↓ Server automaticky vybere:

Content-Encoding: br          # 510KB (79% úspora)
Content-Type: application/json
```

---

## 🔧 **Troubleshooting**

### Pokud komprese nefunguje:
```bash
# Zkontroluj, zda byly vytvořeny kompresované soubory
ls -la data/*.json*

# Otestuj lokálně
node auto_load_example.js
```

### Pro debugging:
```javascript
// Přidej do kódu pro zjištění, jaká komprese se používá
const encoding = response.headers.get('content-encoding');
console.log(`Použita komprese: ${encoding || 'žádná'}`);
```

---

## 📊 **Monitoring úspor**

```javascript
// Automatické logování úspor
const originalSize = 2.4; // MB
const actualSize = response.headers.get('content-length') / 1024 / 1024;
const savings = Math.round((1 - actualSize / originalSize) * 100);

console.log(`💾 Úspora: ${savings}% (${originalSize - actualSize}MB)`);
```

---

## 🎉 **Výsledek:**

✅ **GitHub Actions automaticky kompresuje při každém scrapingu**  
✅ **Server automaticky vybere nejlepší kompresi**  
✅ **Klient automaticky dekompresuje**  
✅ **Až 79% úspora bez změny kódu**  
✅ **Funguje na všech platformách**

**Není potřeba žádná manuální konfigurace!**
