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
  if (!name || !priceArs || priceArs > 100_000_000) return null;
  return {
    name: name.normalize('NFC').slice(0, 100),
    category: String(item.category ?? item.categoria ?? 'General').trim().normalize('NFC').slice(0, 40) || 'General',
    description: String(item.description ?? item.descripcion ?? '').trim().normalize('NFC').slice(0, 240),
    priceArs,
    selected: true,
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
  const commonCategories = new Set(['cafes', 'cafe', 'bebidas', 'pasteleria', 'dulces', 'salados', 'sandwiches', 'desayunos', 'almuerzos', 'postres', 'infusiones', 'tragos', 'entradas', 'principales', 'guarniciones', 'ensaladas', 'pizzas', 'hamburguesas']);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s•·*]+/, '').trim();
    if (!line) continue;
    const priceMatch = line.match(/(\$\s*)?((?:\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[,.]\d{1,2})?)\s*$/);
    if (!priceMatch) {
      const key = simplify(line).replace(/[:：]$/, '');
      const uppercaseHeading = line.length <= 32 && line === line.toLocaleUpperCase('es-AR') && !/[.!?]/.test(line);
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
  const scale = Math.min(1, OCR_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
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
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
      else line += ' ';
    }
    if (line.trim()) lines.push(line.trim());
    pages.push({ page, text: lines.join('\n') });
  }
  return { document, pages };
}

async function ocrPdfPages(pdf, onProgress) {
  if (pdf.pages.length > PDF_OCR_MAX_PAGES) throw new Error(`No se pudo leer texto del PDF. Para OCR, el límite es ${PDF_OCR_MAX_PAGES} páginas por archivo.`);
  postProgress(onProgress, 'El PDF no contiene texto seleccionable. Preparando OCR…');
  const worker = await createOcrWorker(onProgress);
  try {
    const texts = [];
    for (const [index, { page }] of pdf.pages.entries()) {
      const viewport = page.getViewport({ scale: 1.8 });
      const scale = Math.min(1, OCR_MAX_SIDE / Math.max(viewport.width, viewport.height));
      const renderViewport = page.getViewport({ scale: 1.8 * scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext('2d') }).promise;
      postProgress(onProgress, `Leyendo página ${index + 1} de ${pdf.pages.length}…`);
      texts.push((await worker.recognize(canvas)).data.text);
      canvas.width = 0;
      canvas.height = 0;
    }
    return texts.join('\n');
  } finally { await worker.terminate(); }
}

export async function parseMenuFile(file, onProgress = () => {}) {
  if (!file) throw new Error('Elegí un archivo para importar.');
  if (file.size > MAX_FILE_SIZE) throw new Error('El archivo supera el límite de 12 MB.');
  const extension = file.name.split('.').pop().toLowerCase();
  let products = [];
  let method = 'archivo';
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
      const text = pdf.pages.map((page) => page.text).join('\n');
      products = parseTextMenu(text);
      if (!products.length) products = parseTextMenu(await ocrPdfPages(pdf, onProgress));
    } finally { await pdf.document.destroy(); }
    method = 'PDF';
  } else if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(extension)) {
    const worker = await createOcrWorker(onProgress);
    try {
      const canvas = await imageToCanvas(file);
      const result = await worker.recognize(canvas);
      products = parseTextMenu(result.data.text);
      canvas.width = 0;
      canvas.height = 0;
    } finally { await worker.terminate(); }
    method = 'foto';
  } else {
    throw new Error('Formato no compatible. Usá foto, PDF, Word, Excel, CSV, TSV, texto o JSON.');
  }

  if (!products.length) throw new Error('No detectamos productos con precio. Probá con un archivo más nítido o una planilla con columnas de producto y precio.');
  if (products.length > MAX_IMPORT_ROWS) throw new Error(`El archivo contiene más de ${MAX_IMPORT_ROWS} productos. Dividilo en archivos más pequeños para importarlos sin omitir registros.`);
  return { products, method };
}

export function markExistingProducts(imported, existing) {
  const existingNames = new Set(existing.map((item) => simplify(item.name)));
  return imported.map((item) => {
    const duplicate = existingNames.has(simplify(item.name));
    return { ...item, duplicate, selected: !duplicate };
  });
}

