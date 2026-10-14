const MAX_FILE_SIZE = 12 * 1024 * 1024;
const MAX_IMPORT_ROWS = 200;
const PDF_MAX_PAGES = 20;
const PDF_OCR_MAX_PAGES = 5;
const OCR_MAX_SIDE = 2200;

const scriptCache = new Map();
let pdfModule;
let spreadsheetModule;

function loadScript(url, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!scriptCache.has(url)) {
    scriptCache.set(url, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.crossOrigin = 'anonymous';
      script.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error('No se pudo iniciar el lector del archivo.'));
      script.onerror = () => reject(new Error('No se pudo cargar el lector. Revisá tu conexión e intentá nuevamente.'));
      document.head.append(script);
    }));
  }
  return scriptCache.get(url);
}

async function loadPdfJs() {
  pdfModule ||= import('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/build/pdf.min.mjs');
  const pdfjs = await pdfModule;
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/build/pdf.worker.min.mjs';
  return pdfjs;
}

async function loadSpreadsheet() {
  spreadsheetModule ||= import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  return spreadsheetModule;
}

function simplify(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('es-AR');
}

function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const original = String(value ?? '').trim();
  if (!original) return 0;
  const match = original.match(/-?\d[\d.,\s]*/);
  if (!match) return 0;
  let numeric = match[0].replace(/\s/g, '');
  const lastDot = numeric.lastIndexOf('.');
  const lastComma = numeric.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);
  if (decimalAt >= 0) {
    const decimalDigits = numeric.length - decimalAt - 1;
    const hasBothSeparators = lastDot >= 0 && lastComma >= 0;
    if (hasBothSeparators && decimalDigits <= 2) {
      numeric = numeric.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + numeric.slice(decimalAt + 1);
    } else if (!hasBothSeparators && decimalDigits > 0 && decimalDigits <= 2) {
      const before = numeric.slice(0, decimalAt);
      const groups = before.split(/[.,]/);
      const looksLikeThousands = groups.length > 1 && groups.slice(1).every((part) => part.length === 3)
        || groups.length === 1 && decimalDigits === 3;
      numeric = looksLikeThousands ? numeric.replace(/[.,]/g, '') : `${before}.${numeric.slice(decimalAt + 1)}`;
    } else {
      numeric = numeric.replace(/[.,]/g, '');
    }
  }
  const parsed = Number(numeric);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function cleanProduct(item) {
  const name = String(item.name ?? '').replace(/^[\s•·*\-–—]+/, '').trim();
  const priceArs = parsePrice(item.priceArs ?? item.price ?? item.precio ?? item.valor);
  if (!name || !/\p{L}/u.test(name) || !priceArs || priceArs > 100_000_000) return null;
  const confidence = Number(item.confidence);
  return {
    name: name.normalize('NFC').slice(0, 100),
    category: String(item.category ?? item.categoria ?? 'General').trim().normalize('NFC').slice(0, 40) || 'General',
    description: String(item.description ?? item.descripcion ?? '').trim().normalize('NFC').slice(0, 240),
    priceArs,
    ...(Number.isFinite(confidence) ? { confidence: Math.max(0, Math.min(100, Math.round(confidence))) } : {}),
    needsReview: item.needsReview === true,
    selected: item.selected !== false,
  };
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const key = `${simplify(item.name)}|${item.priceArs}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findHeader(headers, aliases) {
  return headers.findIndex((header) => aliases.includes(
    simplify(header).replace(/[_-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
  ));
}

const HEADER_ALIASES = {
  name: ['nombre', 'nombre producto', 'nombre del producto', 'producto', 'articulo', 'item', 'item name', 'product', 'product name', 'name', 'plato'],
  category: ['categoria', 'categoria producto', 'rubro', 'seccion', 'category', 'section', 'tipo'],
  description: ['descripcion', 'detalle', 'description', 'detail'],
  price: ['precio', 'precio ars', 'precio venta', 'price', 'price ars', 'unit price', 'valor', 'valor unitario', 'importe', 'monto', 'ars'],
};

function rowsToProducts(rows) {
  const nonEmpty = rows.filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim()));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((cell) => String(cell ?? ''));
  const columns = Object.fromEntries(Object.entries(HEADER_ALIASES).map(([key, aliases]) => [key, findHeader(headers, aliases)]));
  const hasHeaders = columns.name >= 0 && columns.price >= 0;
  const dataRows = hasHeaders ? nonEmpty.slice(1) : nonEmpty;
  const products = dataRows.map((row) => {
    if (hasHeaders) return cleanProduct({
      name: row[columns.name],
      category: columns.category >= 0 ? row[columns.category] : 'General',
      description: columns.description >= 0 ? row[columns.description] : '',
      priceArs: columns.price >= 0 ? row[columns.price] : '',
    });
    const cells = row.map((cell) => String(cell ?? '').trim()).filter(Boolean);
    const priceIndex = cells.findIndex((cell) => parsePrice(cell) > 0 && /^[\s$€£\d.,]+$/.test(cell));
    if (priceIndex < 0) return null;
    const textCells = cells.filter((_, index) => index !== priceIndex);
    const name = textCells[0] || '';
    const second = textCells[1] || '';
    return cleanProduct({ name, category: textCells.length > 2 ? second : 'General', description: textCells.length > 2 ? textCells.slice(2).join(' ') : '', priceArs: cells[priceIndex] });
  });
  return deduplicate(products);
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const candidates = [',', ';', '\t'];
  const sample = text.split(/\r?\n/).slice(0, 8);
  const ranked = candidates.map((delimiter) => ({
    delimiter,
    count: sample.reduce((sum, line) => sum + Math.max(0, (parseDelimited(line, delimiter)[0]?.length || 1) - 1), 0),
  })).sort((a, b) => b.count - a.count);
  return ranked[0]?.count ? ranked[0].delimiter : null;
}

function parseTextMenu(text) {
  const products = [];
  let category = 'General';
  const commonCategories = new Set(['cafes', 'cafe', 'bebidas', 'otras bebidas', 'para comer', 'combo manana', 'pasteleria', 'dulces', 'salados', 'sandwiches', 'desayunos', 'almuerzos', 'postres', 'infusiones', 'tragos', 'entradas', 'principales', 'guarniciones', 'ensaladas', 'pizzas', 'hamburguesas']);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s•·*]+/, '').trim();
    if (!line) continue;
    const priceMatch = line.match(/(\$\s*)?((?:\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[,.]\d{1,2})?)\s*$/);
    if (!priceMatch) {
      const key = simplify(line).replace(/[:：]$/, '');
      const uppercaseHeading = line.length <= 32 && line === line.toLocaleUpperCase('es-AR') && !/[.!?\d]/.test(line);
      if (commonCategories.has(key) || uppercaseHeading && line.length > 2) category = line.replace(/[:：]$/, '').slice(0, 40);
      continue;
    }
    const priceArs = parsePrice(priceMatch[2]);
    let label = line.slice(0, priceMatch.index).replace(/[.·|\s]+$/, '').trim();
    if (!priceArs || !label) continue;
    let name = label;
    let description = '';
    const split = label.split(/\s+[—–|]\s+/);
    if (split.length > 1) { name = split.shift(); description = split.join(' · '); }
    const product = cleanProduct({ name, category, description, priceArs });
    if (product) products.push(product);
  }
  return deduplicate(products);
}

const MENU_CATEGORIES = new Set([
  'cafe', 'cafes', 'bebidas', 'otras bebidas', 'para comer', 'combo manana', 'comida', 'desayunos',
  'almuerzos', 'cenas', 'pasteleria', 'dulces', 'salados', 'sandwiches', 'postres', 'infusiones',
  'tragos', 'entradas', 'principales', 'guarniciones', 'ensaladas', 'pizzas', 'hamburguesas',
]);

function wordCenter(word) {
  return (word.bbox.x0 + word.bbox.x1) / 2;
}

function wordMiddleY(word) {
  return (word.bbox.y0 + word.bbox.y1) / 2;
}

function findColumnSplit(words, width, height) {
  const intervals = words
    .filter((word) => wordMiddleY(word) >= height * 0.22 && wordMiddleY(word) <= height * 0.9)
    .map((word) => ({ start: Math.max(0, word.bbox.x0), end: Math.min(width, word.bbox.x1) }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const minimumGap = Math.max(16, width * 0.032);
  const candidates = [];
  for (let index = 0; index < merged.length - 1; index += 1) {
    const left = merged[index].end;
    const right = merged[index + 1].start;
    const gap = right - left;
    const split = (left + right) / 2;
    if (gap >= minimumGap && split >= width * 0.34 && split <= width * 0.67) {
      const leftWords = words.filter((word) => wordMiddleY(word) >= height * 0.22 && wordMiddleY(word) <= height * 0.9 && wordCenter(word) < split).length;
      const rightWords = words.filter((word) => wordMiddleY(word) >= height * 0.22 && wordMiddleY(word) <= height * 0.9 && wordCenter(word) >= split).length;
      if (leftWords >= 4 && rightWords >= 4) candidates.push({ split, gap });
    }
  }
  candidates.sort((a, b) => b.gap - a.gap);
  return candidates[0]?.split ?? null;
}

function groupPositionedWords(words, width, height, forceSingleColumn = false) {
  const usable = words.filter((word) => word.text && word.bbox
    && Number.isFinite(word.bbox.x0) && Number.isFinite(word.bbox.x1)
    && Number.isFinite(word.bbox.y0) && Number.isFinite(word.bbox.y1));
  if (!usable.length) return { lines: [], split: null, bounds: [] };

  const split = forceSingleColumn ? null : findColumnSplit(usable, width, height);
  const heights = usable.map((word) => Math.max(1, word.bbox.y1 - word.bbox.y0)).sort((a, b) => a - b);
  const lineTolerance = Math.max(4, heights[Math.floor(heights.length / 2)] * 0.62);
  const sorted = [...usable].sort((a, b) => wordMiddleY(a) - wordMiddleY(b) || wordCenter(a) - wordCenter(b));
  const rawLines = [];
  for (const word of sorted) {
    const centerY = wordMiddleY(word);
    let line = rawLines.at(-1);
    if (!line || Math.abs(centerY - line.centerY) > lineTolerance) {
      line = { centerY, words: [] };
      rawLines.push(line);
    }
    line.words.push(word);
    line.centerY = line.words.reduce((sum, item) => sum + wordMiddleY(item), 0) / line.words.length;
  }

  const bodyWords = usable.filter((word) => wordMiddleY(word) >= height * 0.22 && wordMiddleY(word) <= height * 0.9);
  const columns = split === null ? [bodyWords.length ? bodyWords : usable] : [
    bodyWords.filter((word) => wordCenter(word) < split),
    bodyWords.filter((word) => wordCenter(word) >= split),
  ];
  const bounds = columns.map((column) => ({
    minX: Math.min(...column.map((word) => word.bbox.x0)),
    maxX: Math.max(...column.map((word) => word.bbox.x1)),
  }));
  const lines = [];
  for (const rawLine of rawLines) {
    const groups = split === null
      ? [rawLine.words]
      : [rawLine.words.filter((word) => wordCenter(word) < split), rawLine.words.filter((word) => wordCenter(word) >= split)];
    groups.forEach((lineWords, columnIndex) => {
      if (!lineWords.length) return;
      lineWords.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      lines.push({ words: lineWords, column: columnIndex, centerY: rawLine.centerY, height: Math.max(...lineWords.map((word) => word.bbox.y1 - word.bbox.y0)) });
    });
  }
  lines.sort((a, b) => a.centerY - b.centerY || a.column - b.column);
  return { lines, split, bounds };
}

function getOcrWords(data) {
  const words = [];
  for (const block of data?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          if (word.text?.trim() && word.bbox) words.push({ text: word.text.trim(), bbox: word.bbox, confidence: Number(word.confidence) });
        }
      }
    }
  }
  return words;
}

function priceFromLine(words, bounds) {
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const current = words[index];
    let token = current.text.replace(/[Oo]/g, '0').replace(/^[sS](?=\d)/, '$');
    let currencyIndex = -1;
    if (index > 0 && /^\$|^[sS]$/.test(words[index - 1].text)) currencyIndex = index - 1;
    if (/^\$?$/.test(token) && index + 1 < words.length) {
      const next = words[index + 1].text.replace(/[Oo]/g, '0');
      if (/^\d[\d.,]*$/.test(next)) { token = `$${next}`; currencyIndex = index; }
    }
    if (!/^\$?\d[\d.,]*$/.test(token)) continue;
    const digits = token.replace(/\D/g, '');
    const hasCurrency = token.startsWith('$') || currencyIndex >= 0;
    const hasGroupedThousands = /\d[.,]\d{3}(?:$|[.,]\d{1,2}$)/.test(token);
    const edge = bounds ? Math.max(12, (bounds.maxX - bounds.minX) * 0.26) : 0;
    const rightAligned = bounds && current.bbox.x0 >= bounds.maxX - edge;
    if (!hasCurrency && !hasGroupedThousands && !(digits.length >= 4 && rightAligned)) continue;
    const priceArs = parsePrice(token);
    if (priceArs) return { priceArs, priceIndex: index, currencyIndex, confidence: Number.isFinite(current.confidence) ? current.confidence : 0 };
  }
  return null;
}

function lineConfidence(words) {
  const values = words.map((word) => word.confidence).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function parsePositionedMenu(words, width, height, options = {}) {
  const grouped = groupPositionedWords(words, width, height, options.forceSingleColumn === true);
  const products = [];
  const currentCategory = ['General', 'General'];
  let skippedPriceLines = 0;
  for (const line of grouped.lines) {
    const { column, words: lineWords, centerY } = line;
    const bounds = grouped.bounds[column] ?? grouped.bounds[0];
    const price = priceFromLine(lineWords, bounds);
    const nameWords = price
      ? lineWords.filter((word, index) => index !== price.priceIndex && index !== price.currencyIndex && word.bbox.x0 < lineWords[price.priceIndex].bbox.x0)
      : lineWords;
    const text = lineWords.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
    const label = nameWords.map((word) => word.text).join(' ').replace(/\s+/g, ' ').replace(/[\s.,:;|–—-]+$/, '').trim();
    if (price && label && /\p{L}/u.test(label)) {
      const priceConfidence = Number.isFinite(price.confidence) ? price.confidence : lineConfidence(lineWords);
      const confidence = Math.min(lineConfidence(nameWords), priceConfidence);
      const product = cleanProduct({
        name: label,
        category: currentCategory[column],
        priceArs: price.priceArs,
        confidence,
        needsReview: confidence < 68,
        selected: confidence >= 68,
      });
      if (product) {
        product._sourceY = centerY;
        product._column = column;
        products.push(product);
      }
      continue;
    }
    if (price) { skippedPriceLines += 1; continue; }
    if (centerY < height * 0.22 || centerY > height * 0.9) continue;

    const key = simplify(text).replace(/[.:]$/, '');
    const uppercaseHeading = text.length <= 32 && text === text.toLocaleUpperCase('es-AR') && !/[.!?\d]/.test(text) && text.split(/\s+/).length <= 4;
    if (MENU_CATEGORIES.has(key) || uppercaseHeading) {
      currentCategory[column] = text.replace(/[:：]$/, '').slice(0, 40);
      continue;
    }

    const previous = [...products].reverse().find((product) => product._column === column);
    if (previous && centerY - previous._sourceY <= Math.max(48, line.height * 3.8)) {
      if (/combo/i.test(previous.category) || /\+/.test(previous.name)) previous.name = `${previous.name} ${text}`.slice(0, 100);
      else previous.description = `${previous.description} ${text}`.trim().slice(0, 240);
    } else if (/\d/.test(text)) skippedPriceLines += 1;
  }

  for (const product of products) { delete product._sourceY; delete product._column; }
  return { products: deduplicate(products), skippedPriceLines, split: grouped.split };
}

function countExplicitPriceTokens(words) {
  return words.filter((word) => /^\$?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(word.text.replace(/[Oo]/g, '0'))).length;
}

function menuParseScore(parsed) {
  const confidence = parsed.products.reduce((sum, product) => sum + (product.confidence ?? 100), 0);
  return parsed.products.length + confidence / 500 - parsed.skippedPriceLines * 0.4;
}

async function recognizeMenuCanvas(worker, canvas, onProgress) {
  const first = await worker.recognize(canvas, {}, { blocks: true });
  const firstWords = getOcrWords(first.data);
  const primary = parsePositionedMenu(firstWords, canvas.width, canvas.height);
  const priceTokens = countExplicitPriceTokens(firstWords);
  const uncertain = primary.products.filter((product) => product.needsReview).length;
  const shouldRetry = primary.products.length < 3
    || primary.skippedPriceLines > 1
    || (priceTokens >= 4 && primary.products.length < priceTokens * 0.82)
    || (primary.products.length > 0 && uncertain / primary.products.length > 0.35);
  if (!shouldRetry) return primary;

  postProgress(onProgress, 'Comprobando las líneas dudosas con una segunda lectura…');
  const crops = [];
  if (primary.split !== null) {
    for (const [left, right] of [[0, primary.split], [primary.split, canvas.width]]) {
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.round(right - left));
      crop.height = canvas.height;
      crop.getContext('2d', { willReadFrequently: true }).drawImage(canvas, left, 0, right - left, canvas.height, 0, 0, crop.width, crop.height);
      crops.push(crop);
    }
  } else crops.push(canvas);

  let alternative = { products: [], skippedPriceLines: 0, split: null };
  for (const crop of crops) {
    const result = await worker.recognize(crop, { tessedit_pageseg_mode: '6' }, { blocks: true });
    const parsed = parsePositionedMenu(getOcrWords(result.data), crop.width, crop.height, { forceSingleColumn: crop !== canvas });
    alternative.products.push(...parsed.products);
    alternative.skippedPriceLines += parsed.skippedPriceLines;
    if (crop !== canvas) { crop.width = 0; crop.height = 0; }
  }
  alternative.products = deduplicate(alternative.products);
  return menuParseScore(alternative) > menuParseScore(primary) ? alternative : primary;
}

function mapJsonProducts(value) {
  const rows = Array.isArray(value) ? value : value?.items || value?.products || value?.menu || value?.productos || [];
  if (!Array.isArray(rows)) return [];
  return deduplicate(rows.map((row) => cleanProduct({
    name: row.name ?? row.nombre ?? row.product ?? row.producto ?? row.plato,
    category: row.category ?? row.categoria ?? row.section ?? row.rubro,
    description: row.description ?? row.descripcion ?? row.detail,
    priceArs: row.priceArs ?? row.price ?? row.precio ?? row.valor,
  })));
}

function postProgress(onProgress, message) {
  if (typeof onProgress === 'function') onProgress(message);
}

async function createOcrWorker(onProgress) {
  const tesseract = await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js', 'Tesseract');
  return tesseract.createWorker('spa', 1, {
    logger: (info) => {
      if (info.status === 'recognizing text') postProgress(onProgress, `Leyendo texto (${Math.round((info.progress || 0) * 100)} %)…`);
      else if (info.status === 'loading language traineddata') postProgress(onProgress, 'Preparando el reconocimiento en español…');
      else if (info.status === 'loading tesseract core') postProgress(onProgress, 'Preparando el lector de imágenes…');
    },
  });
}

async function imageToCanvas(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(2, OCR_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

async function pdfText(pdfjs, file) {
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (document.numPages > PDF_MAX_PAGES) { await document.destroy(); throw new Error(`El PDF tiene más de ${PDF_MAX_PAGES} páginas. Separalo en archivos más pequeños para importarlo.`); }
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    const words = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
      else line += ' ';

      const parts = item.str.match(/\S+/g) ?? [];
      if (!parts.length) continue;
      const [a, b, c, d, e, f] = viewport.transform;
      const [ta, tb, tc, td, tx, ty] = item.transform;
      const x = a * tx + c * ty + e;
      const y = b * tx + d * ty + f;
      const itemWidth = Math.max(1, Number(item.width) || parts.join('').length * 5);
      const itemHeight = Math.max(5, Number(item.height) || Math.hypot(tb, td));
      let cursor = 0;
      for (const part of parts) {
        const offset = item.str.indexOf(part, cursor);
        const start = Math.max(cursor, offset);
        const end = start + part.length;
        const x0 = x + itemWidth * start / item.str.length;
        const x1 = x + itemWidth * end / item.str.length;
        words.push({ text: part, bbox: { x0, x1: Math.max(x0 + 1, x1), y0: y - itemHeight, y1: y }, confidence: 100 });
        cursor = end;
      }
    }
    if (line.trim()) lines.push(line.trim());
    pages.push({ page, text: lines.join('\n'), words, width: viewport.width, height: viewport.height });
  }
  return { document, pages };
}

async function ocrPdfPages(pdf, onProgress) {
  if (pdf.pages.length > PDF_OCR_MAX_PAGES) throw new Error(`No se pudo leer texto del PDF. Para OCR, el límite es ${PDF_OCR_MAX_PAGES} páginas por archivo.`);
  postProgress(onProgress, 'El PDF no contiene texto seleccionable. Preparando OCR…');
  const worker = await createOcrWorker(onProgress);
  try {
    const products = [];
    let skippedPriceLines = 0;
    for (const [index, { page }] of pdf.pages.entries()) {
      const viewport = page.getViewport({ scale: 1.8 });
      const scale = Math.min(1, OCR_MAX_SIDE / Math.max(viewport.width, viewport.height));
      const renderViewport = page.getViewport({ scale: 1.8 * scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d') }).promise;
      postProgress(onProgress, `Leyendo página ${index + 1} de ${pdf.pages.length}…`);
      const parsed = await recognizeMenuCanvas(worker, canvas, onProgress);
      products.push(...parsed.products);
      skippedPriceLines += parsed.skippedPriceLines;
      canvas.width = 0;
      canvas.height = 0;
    }
    return { products: deduplicate(products), skippedPriceLines };
  } finally { await worker.terminate(); }
}

export async function parseMenuFile(file, onProgress = () => {}) {
  if (!file) throw new Error('Elegí un archivo para importar.');
  if (file.size > MAX_FILE_SIZE) throw new Error('El archivo supera el límite de 12 MB.');
  const extension = file.name.split('.').pop().toLowerCase();
  let products = [];
  let method = 'archivo';
  let skippedPriceLines = 0;
  postProgress(onProgress, 'Analizando el archivo en este dispositivo…');

  if (['csv', 'tsv', 'txt', 'rtf', 'json'].includes(extension)) {
    let text = await file.text();
    if (extension === 'json') products = mapJsonProducts(JSON.parse(text));
    else {
      if (extension === 'rtf') text = text.replace(/\\'[\da-f]{2}/gi, ' ').replace(/\\[a-z]+-?\d* ?/gi, ' ').replace(/[{}]/g, ' ');
      const delimiter = extension === 'tsv' ? '\t' : extension === 'csv' ? detectDelimiter(text) : null;
      if (delimiter) products = rowsToProducts(parseDelimited(text, delimiter));
      if (!products.length) products = parseTextMenu(text);
    }
    method = extension.toUpperCase();
  } else if (['xlsx', 'xls', 'xlsm', 'ods'].includes(extension)) {
    const XLSX = await loadSpreadsheet();
    const workbook = XLSX.read(await file.arrayBuffer());
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new Error('La planilla no contiene hojas para importar.');
    products = rowsToProducts(XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: true, defval: '' }));
    method = 'planilla';
  } else if (extension === 'docx') {
    const mammoth = await loadScript('https://cdn.jsdelivr.net/npm/mammoth@1.11.0/mammoth.browser.min.js', 'mammoth');
    const converted = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const doc = new DOMParser().parseFromString(converted.value, 'text/html');
    const rows = [...doc.querySelectorAll('tr')].map((row) => [...row.cells].map((cell) => cell.textContent.trim()));
    products = rowsToProducts(rows);
    if (!products.length) products = parseTextMenu(doc.body.textContent);
    method = 'Word';
  } else if (extension === 'pdf') {
    const pdfjs = await loadPdfJs();
    const pdf = await pdfText(pdfjs, file);
    try {
      for (const page of pdf.pages) {
        const parsed = parsePositionedMenu(page.words, page.width, page.height);
        products.push(...parsed.products);
        skippedPriceLines += parsed.skippedPriceLines;
      }
      products = deduplicate(products);
      if (!products.length) {
        const parsed = await ocrPdfPages(pdf, onProgress);
        products = parsed.products;
        skippedPriceLines += parsed.skippedPriceLines;
      }
    } finally { await pdf.document.destroy(); }
    method = 'PDF';
  } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(extension)) {
    const worker = await createOcrWorker(onProgress);
    try {
      const canvas = await imageToCanvas(file);
      const parsed = await recognizeMenuCanvas(worker, canvas, onProgress);
      products = parsed.products;
      skippedPriceLines = parsed.skippedPriceLines;
      canvas.width = 0;
      canvas.height = 0;
    } finally { await worker.terminate(); }
    method = 'foto';
  } else {
    throw new Error('Formato no compatible. Usá foto, PDF, Word, Excel, CSV, TSV, texto o JSON.');
  }

  if (!products.length) throw new Error('No detectamos productos con precio. Probá con un archivo más nítido o una planilla con columnas de producto y precio.');
  if (products.length > MAX_IMPORT_ROWS) throw new Error(`El archivo contiene más de ${MAX_IMPORT_ROWS} productos. Dividilo en archivos más pequeños para importarlos sin omitir registros.`);
  return {
    products,
    method,
    quality: {
      needsReview: products.filter((item) => item.needsReview).length,
      skippedPriceLines,
    },
  };
}

export function markExistingProducts(imported, existing) {
  const existingNames = new Set(existing.map((item) => simplify(item.name)));
  return imported.map((item) => {
    const duplicate = existingNames.has(simplify(item.name));
    return { ...item, duplicate, selected: !duplicate && item.selected !== false };
  });
}

