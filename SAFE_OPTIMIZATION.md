# 🚀 Bezpečná optimalizace ČSFD JSON (bez rozbití aplikace!)

## ✅ **Ideální řešení: Komprese**

**Zachovává původní strukturu dat** - aplikace pokračuje normálně!

### 📊 Výsledky komprese:
- **Původní**: 2.4MB  
- **Gzip**: 740KB (69% úspora)
- **Brotli**: 510KB (**79% úspora**)

---

## 🛠️ **Implementace (3 kroky):**

### 1. Build proces
```bash
# Spustit před nasazením
node build_compress.mjs
```

### 2. Server konfigurace
**Next.js/Vercel** - automaticky podporuje brotli/gzip ✅

**Express.js**:
```javascript
import { serveCompressedJson } from './compression_guide.mjs';

app.get('/api/csfd-data', (req, res) => {
    serveCompressedJson(req, res, './data/csfd_ratings.json');
});
```

**Nginx**:
```nginx
location ~* \.json$ {
    gzip on;
    brotli on;  # pokud máte brotli modul
    gzip_types application/json;
}
```

### 3. Klient (bez změny!)
```javascript
// Váš existující kód zůstává stejný!
const data = await fetch('/api/csfd-data').then(r => r.json());

// Nebo s helper funkcí:
import { loadCsfdData } from './compression_guide.mjs';
const data = await loadCsfdData('/api/csfd-data');
```

---

## 💡 **Výhody tohoto řešení:**

✅ **Nerozbije existující aplikaci**  
✅ **79% úspora místa**  
✅ **Rychlejší načítání**  
✅ **Transparentní pro vývojáře**  
✅ **Automatické v prohlížečích**  
✅ **Podpora všech serverů**  

---

## 🎯 **Doporučení pro implementaci:**

### Pro produkci:
1. Používejte **brotli kompresí** (79% úspora)
2. Gzip jako fallback pro starší servery
3. Server automaticky vybere nejlepší kompresi

### Pro development:
- Původní JSON funguje normálně
- Žádné změny v kódu nejsou potřeba

---

## 📁 **Soubory k použití:**

- `compression_guide.mjs` - kompletní implementační guide
- `build_compress.mjs` - build skript (spustit před nasazením)
- `csfd_ratings.json.br` - brotli kompresovaná data
- `csfd_ratings.json.gz` - gzip kompresovaná data

---

## ⚠️ **Nepotřebné soubory (můžete smazat):**

- `optimize_json.mjs` - strukturální optimalizace (risky)
- `decode_json.mjs` - decoder (nepotřebný)
- `decode_helpers.mjs` - helper funkce (nepotřebné)
- `csfd_ratings_optimized.json` - změněná struktura (risky)
- `decode_map.json` - mapa pro dekódování (nepotřebná)

**Tyto soubory by rozbily vaši aplikaci - nepoužívejte je!**
