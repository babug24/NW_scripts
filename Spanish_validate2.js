#!/usr/bin/env node

/**
 * Spanish Language Conversion Validator – CONCURRENT VERSION
 * Uses a single browser, concurrent pages, and a fixed profile folder.
 * Handles 4000+ URLs efficiently without EBUSY errors.
 */

const puppeteer = require('puppeteer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ============================================================
//  GLOBAL UNHANDLED REJECTION HANDLER (prevents crashes)
// ============================================================
process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ Unhandled Rejection (ignored):', reason?.message || reason);
});

// ============================================================
//  CONFIGURATION
// ============================================================
const SAMPLE_COUNT = 12;
const REPORTS_DIR = path.join(__dirname, 'reports');
const CONCURRENCY = 1;                     // safe default: shared-browser concurrency causes false failures on Nationwide pages
const PROFILE_DIR = path.join(__dirname, 'puppeteer_profile'); // persistent profile

// Ensure directories exist
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

// ============================================================
//  SPANISH WORDS (your list – unchanged)
// ============================================================
const SPANISH_WORDS = [
  'protegemos', 'vehículo', 'propiedad', 'negocios', 'inversiones',
  'reclamos', 'factura', 'código', 'cotización', 'explorar',  'financieros', 'jubilación', 'solicitar', 'póliza', 'temporal',
  'personas', 'empresas', 'mascotas', 'eventos', 'empleados',  'bienes', 'sueños', 'necesidades', 'ahorro', 'hogar',
  'viaje', 'salud', 'seguro', 'cobertura', 'tarifa',  'analiza', 'ingresar', 'comenzar', 'buscar', 'protección',
  'disposición', 'beneficios', 'miembros',  'mucho más', 'hace falta', 'iniciar sesión',
  'gustaría hacer', 'paquete', 'código postal', 'comenzar la cotización',  'centro de información', 'recursos de seguro', 'pequeñas empresas',
  'deportes de motor', 'planificación de emergencias',  'agricultura y agroindustria', 'centro de recursos cibernéticos',
  'encontrar un profesional financiero',  'preguntas frecuentes sobre inversiones', 'finanzas a nivel nacional',
  'ahora desde nationwide', 'el blog advisor advocate', 'agencia forward',  'Ingreso a tu cuenta','Nombre de usuario','Buscar un agente',
  'Buscar por nombre o ubicación','Código postal',  'seguro', 'cobertura', 'póliza', 'inicio', 'contacto',
  'ahorrar', 'protección', 'cotizar', 'reclamar', 'siniestro',  'automóvil', 'vida', 'salud', 'beneficio', 'deducible',
  'prima', 'renovación', 'cancelación', 'asegurado', 'aseguradora',  'indemnización', 'responsabilidad', 'daños', 'lesiones',
  'asistencia', 'remolque', 'alquiler', 'reembolso','Seguro de',  'Vehículo','Propiedad','Negocios','Inversiones','Recursos',
  'Pagar una factura','automóvil','Comenzar la cotización', 'Continuar con un presupuesto guardado','Buscar un agente',
  'Acerca de nosotros','Para agentes','Empleos','Centro de ayuda','Ahora del blog de Nationwide',
  'Privacidad','Ciberseguridad y fraude','Ley de Priv. del Consumidor de CA','Accesibilidad','Términos y condiciones','No vender ni compartir mi info. personal',
  'Recursos para agentes','Socios especializados/EyS,Profesionales financieros','Buscadores de empleo,Reclamos',
  'Profesional financiero y empresa de inversión','Inversores institucionalesEmpleador/patrocinador del plan','Administrador de pensiones',
  'Socios y desarrolladores','Privacidad','Ciberseguridad y fraude','Ley de Priv. del Consumidor de CA',
  'Accesibilidad','Términos y condiciones','No vender ni compartir mi info. personal',
  'Formas de ahorrar en tu seguro de inquilinos','Descuentos en seguros de inquilinos',
  'Inquilinos','Coberturas','Descuentos','Reclamaciones','Obtén una cotización',
  'Ningún reclamo','Descuentos adicionales','Consulta On Your Side','Seguro comercial',
  'Programar una llamada','Buscar un agente comercial','Buscar un agente agrícola','Continuar una cotización guardada',
  'Términos y condiciones de uso','Volver arriba','Descargo de garantías','Limitación de responsabilidades','Su privacidad y seguridad en el sitio',
  'Cómo llevar a cabo negocios electrónicamente',  'Autoservicio de reclamos',
  'Propiedad intelectual, marcas registradas y derechos de autor',  'Hipervínculos ',  'Uso de otros sitios adicionales ',  'Información acerca del funcionamiento del sitio ',  'Envío de ideas no solicitadas ',
  'Descargos importantes sobre productos de Nationwide',  'Lea más información acerca de este acuerdo',
  'Términos y condiciones de uso de los SMS y MMS','Envía un correo electrónico',
  '¿De qué se trata tu correo electrónico?','Cancelar','Continuar','Ataques de ingeniería social con IA generativa',
  'descubre el engaño','Cómo identificar y evitar estafas de soporte técnico',
  'Seguro de motocicleta','Aprovecha los beneficios de un seguro de motocicleta durante todo el año',
  'Granja y rancho','Comercial','Seguridad y prevención de riesgos','Ag Insight Center','Fundada por agricultores',
  'Agent resources','Explore products','Industry insights','Become appointed',
  'Iniciar sesión','Agricultura y ganadería','Comercial','Seguridad y gestión de riesgos','Centro de información agrícola','Fundado por agricultores',
  'A nivel nacional Cliente privado','Productos','Solicitudes y formularios','Presupuestos y servicio','Recursos','Sobre nosotros',
  'Arma un paquete de seguro y ahorra dinero'
];

// ============================================================
//  HELP / USAGE
// ============================================================
function showHelp() {
  console.log(`
Spanish Language Conversion Validator (Concurrent)

Usage:
  node validate_concurrent.js --file <filename> [--debug] [--concurrency N]
  node validate_concurrent.js <url1> <url2> ... [--debug] [--concurrency N]

Options:
  --file <filename>   Read URLs from CSV or plain text (one per line)
  --debug             Run browser in non‑headless mode (visible)
  --concurrency N     Max parallel pages (default: 5)
  --help              Show this help

Output: Excel report saved in "reports/spanish_conversion_report_<timestamp>.xlsx"
`);
  process.exit(0);
}

// ============================================================
//  INPUT PARSING (unchanged)
// ============================================================
function parseArguments() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) showHelp();

  const urls = [];
  let inputFile = null;
  let debug = false;
  let concurrency = CONCURRENCY;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file') {
      inputFile = args[++i];
      if (!inputFile) {
        console.error('❌ Missing filename after --file');
        process.exit(1);
      }
    } else if (arg === '--debug') {
      debug = true;
    } else if (arg === '--concurrency') {
      concurrency = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(concurrency) || concurrency < 1) {
        console.error('❌ Invalid concurrency value');
        process.exit(1);
      }
    } else if (!arg.startsWith('--')) {
      urls.push(arg);
    }
  }

  let urlList = [];
  if (inputFile) {
    urlList = readUrlsFromFile(inputFile);
  } else if (urls.length > 0) {
    urlList = urls;
  } else {
    console.warn('⚠️  No input provided. Using default fallback URLs.');
    urlList = [
      'https://www.example.com/page1',
      'https://www.example.com/page2',
      'https://www.example.com/page3'
    ];
  }

  if (concurrency > 1) {
    console.warn('⚠️  Warning: Nationwide pages are sensitive to shared-browser concurrency. Forcing concurrency to 1 to avoid false FAILs and missed validations.');
    concurrency = 1;
  }

  return { urls: urlList, debug, concurrency };
}

function readUrlsFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  const ext = path.extname(filePath).toLowerCase();
  let lines;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    lines = content.split('\n').filter(line => line.trim().length > 0);
  } catch (err) {
    console.error(`❌ Error reading file: ${err.message}`);
    process.exit(1);
  }

  if (ext === '.csv') {
    return parseCsvUrls(lines);
  } else {
    return lines
      .map(line => line.replace(/^#.*$/, '').trim())
      .filter(u => u.length > 0);
  }
}

function parseCsvUrls(lines) {
  function parseRow(row) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  const rows = lines.map(parseRow);
  if (rows.length === 0) return [];

  const header = rows[0].map(h => h.toLowerCase());
  const urlColIndex = header.findIndex(h =>
    ['url', 'link', 'website', 'site', 'address'].includes(h)
  );

  const startRow = (urlColIndex !== -1) ? 1 : 0;
  const colIndex = (urlColIndex !== -1) ? urlColIndex : 0;

  const urls = [];
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (row.length > colIndex) {
      let url = row[colIndex].replace(/^"|"$/g, '').trim();
      if (url) urls.push(url);
    }
  }
  return urls;
}

// ============================================================
//  UTILITY FUNCTIONS (all from original – unchanged)
// ============================================================

function isSpanishUrl(url) {
  return /^https:\/\/espanol\..*/.test(url) || /\/espanol/.test(url);
}

function isValidSpanishUrl(url) {
  if (!url) return false;
  const lower = String(url).toLowerCase();

  const hasSpanishSubdomain = /^https:\/\/espanol\./.test(lower);
  const hasSpanishPath = /\/espanol\b/.test(lower);
  const hasLocaleParam = /([?&](lang|locale|language)=(es|es-us|es-mx|es-ar|es-co|es-cl|es-pr|es-419)|[?&]hl=es|[?&]language=es)/i.test(lower);
  const hasSpanishPathSegment = /(^|\/)(es|es-[a-z0-9-]+)(\/|$)/.test(lower.replace(/^https?:\/\/[^/]+/i, ''));

  return hasSpanishSubdomain || hasSpanishPath || hasLocaleParam || hasSpanishPathSegment;
}

function isTargetClosedError(err) {
  const message = (err && (err.message || String(err))) || '';
  return /Target closed|Target page, context or worker has been closed|Execution context was destroyed|Protocol error \(Runtime\.callFunctionOn\)|Target closed/i.test(message);
}

async function evaluatePageSafe(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (err) {
    if (isTargetClosedError(err)) {
      return null;
    }
    throw err;
  }
}

async function findEnEspanolLink(page) {
  const footerSelectors = [
    'header', '.header', '#header', '.navbar', '.navigation',
    '[role="banner"]', '[role="navigation"]', '.global-nav', '.top-nav',
    '.global-header', 'div[class*="GlobalNav"]', 'div[class*="Navigation"]',
    'footer', '.footer', '#footer', 'div[class*="footer"]',
    'div[class*="Footer"]', '.site-footer', '.footer-container',
    '[role="contentinfo"]', '.nav-footer', '.nw-footer', '.global-footer'
  ];

  for (const sel of footerSelectors) {
    try {
      const footer = await page.$(sel);
      if (footer) {
        const linkHandle = await page.evaluateHandle((footerEl) => {
          const checkLink = (el) => {
            if (!el) return false;
            const text = (el.textContent || '').trim().toLowerCase();
            const matchesSpanishLinkText = text.includes('en español') || text === 'español' || text.includes('espanol');
            if (!matchesSpanishLinkText) return false;

            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const hidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
            const zeroSize = rect.width <= 0 || rect.height <= 0;
            const offscreen = el.offsetParent === null && rect.width === 0 && rect.height === 0;
            return !hidden && !zeroSize && !offscreen;
          };

          const links = footerEl.querySelectorAll('a');
          for (const a of links) {
            if (checkLink(a)) return a;
          }
          return null;
        }, footer).catch(() => null);
        if (!linkHandle) continue;
        const isNull = await evaluatePageSafe(page, el => el === null, linkHandle).catch(() => true);
        if (!isNull) {
          return linkHandle;
        }
      }
    } catch (_) {}
  }

  const linkHandle = await page.evaluateHandle(() => {
    const checkLink = (el) => {
      if (!el) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const matchesSpanishLinkText = text.includes('en español') || text === 'español' || text.includes('espanol');
      if (!matchesSpanishLinkText) return false;

      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const hidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      const zeroSize = rect.width <= 0 || rect.height <= 0;
      const offscreen = el.offsetParent === null && rect.width === 0 && rect.height === 0;
      return !hidden && !zeroSize && !offscreen;
    };

    const links = document.querySelectorAll('a');
    for (const a of links) {
      if (checkLink(a)) return a;
    }
    return null;
  }).catch(() => null);

  if (!linkHandle) {
    console.warn('⚠️  "En Español" link not found in header/footer regions or full page scan.');
    return null;
  }

  const isNull = await evaluatePageSafe(page, el => el === null, linkHandle).catch(() => true);
  if (isNull) {
    console.warn('⚠️  "En Español" link not found in header/footer regions or full page scan.');
    return null;
  }
  return linkHandle;
}

async function isClickable(page, elementHandle) {
  if (!elementHandle) return { clickable: false, reason: 'Element handle is null' };
  try {
    const result = await evaluatePageSafe(page, el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.display !== 'none' &&
                      style.visibility !== 'hidden' &&
                      el.offsetParent !== null &&
                      rect.width > 0 && rect.height > 0;
      const enabled = !el.disabled;
      const pointerEvents = style.pointerEvents !== 'none';
      return { visible, enabled, pointerEvents, rect: { width: rect.width, height: rect.height } };
    }, elementHandle);
    if (result === null) return { clickable: false, reason: 'Target closed during visibility check' };
    if (!result.visible) return { clickable: false, reason: 'Element not visible' };
    if (!result.enabled) return { clickable: false, reason: 'Element disabled' };
    if (!result.pointerEvents) return { clickable: false, reason: 'pointer-events: none' };
    if (result.rect.width === 0 || result.rect.height === 0)
      return { clickable: false, reason: 'Zero size' };
    return { clickable: true, reason: '' };
  } catch (e) {
    return { clickable: false, reason: `Error: ${e.message}` };
  }
}

async function clearBrowserCache(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCache');
    console.log('   ✅ Browser cache cleared.');
  } catch (err) {
    console.warn(`   ⚠️  Could not clear cache: ${err.message}`);
  }
}

async function extractMainContent(page, count = SAMPLE_COUNT, debug = false) {
  console.log('   Waiting for app-root...');
  try {
    await page.waitForSelector('app-root', { timeout: 10000 });
    console.log('   ✅ app-root found.');
  } catch (_) {
    console.warn('   ⚠️  app-root not found, falling back to body.');
  }

  console.log('   Waiting for content to load...');
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector('app-root');
        if (!root) return false;
        return root.textContent.trim().length > 100;
      },
      { timeout: 15000 }
    );
    console.log('   ✅ Content loaded.');
  } catch (_) {
    console.warn('   ⚠️  Content not loaded after 15s, proceeding anyway.');
  }

  // Scroll to trigger lazy loading (detach-safe)
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body ? document.body.scrollHeight : 0;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight || totalHeight > 3000) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
  } catch (err) {
    console.warn(`   ⚠️  Scroll notice: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 1500));

  let texts = [];
  try {
    texts = await evaluatePageSafe(page, (c, isDebug) => {
      function getClassString(el) {
        if (!el) return '';
        if (typeof el.className === 'string') return el.className;
        if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
        return String(el.className || '');
      }

      function getCleanText(el) {
        const clone = el.cloneNode(true);
        const remove = clone.querySelectorAll('style, script, noscript, link, meta, svg, button, input, select, textarea');
        remove.forEach(el => el.remove());
        return clone.textContent.trim();
      }

      function isUIElement(el) {
        const tag = el.tagName.toLowerCase();
        if (['header', 'footer', 'nav', 'aside', 'script', 'style', 'noscript', 'link', 'meta', 'svg', 'template', 'button', 'input', 'select', 'textarea'].includes(tag)) return true;
        const id = (el.id || '').toLowerCase();
        const cls = getClassString(el).toLowerCase();
        const uiPatterns = ['nav', 'menu', 'sidebar', 'breadcrumb', 'toolbar', 'topbar', 'header', 'footer'];
        for (const p of uiPatterns) {
          if (id.includes(p) || cls.includes(p)) return true;
        }
        let parent = el.parentElement;
        while (parent) {
          const pid = (parent.id || '').toLowerCase();
          const pcls = getClassString(parent).toLowerCase();
          for (const p of uiPatterns) {
            if (pid.includes(p) || pcls.includes(p)) return true;
          }
          parent = parent.parentElement;
        }
        return false;
      }

      const container = document.querySelector('app-root') || document.body;
      if (!container) return [];
      const all = container.querySelectorAll('*');
      const candidates = [];
      for (const el of all) {
        if (isUIElement(el)) continue;
        const text = getCleanText(el);
        if (text.length > 50) {
          candidates.push(text);
        }
      }

      candidates.sort((a, b) => b.length - a.length);

      const samples = [];
      const seen = new Set();
      for (const text of candidates) {
        if (samples.length >= c) break;
        if (!seen.has(text)) {
          seen.add(text);
          samples.push(text);
        }
      }

      if (samples.length < c) {
        // exclude nav/header/footer here too, otherwise shared Spanish boilerplate can mask untranslated main content
        const containerClone = container.cloneNode(true);
        containerClone.querySelectorAll('header, footer, nav, aside, [id*="nav" i], [class*="nav" i], [id*="menu" i], [class*="menu" i], [id*="sidebar" i], [class*="sidebar" i], [id*="breadcrumb" i], [class*="breadcrumb" i], [id*="toolbar" i], [class*="toolbar" i], [id*="topbar" i], [class*="topbar" i], [id*="header" i], [class*="header" i], [id*="footer" i], [class*="footer" i]').forEach(el => el.remove());
        const bodyText = getCleanText(containerClone);
        const chunks = bodyText.split(/\n\s*\n|\.\s+|\?\s+/).filter(s => s.length > 40);
        for (const chunk of chunks) {
          if (samples.length >= c) break;
          if (!seen.has(chunk)) {
            seen.add(chunk);
            samples.push(chunk);
          }
        }
      }

      if (isDebug && samples.length > 0) {
        console.log('   Debug: first sample (first 150 chars):', samples[0].substring(0, 150));
      }
      return samples.slice(0, c);
    }, count, debug);
    if (texts === null) texts = [];
  } catch (err) {
    console.warn(`   ⚠️  Primary extraction notice: ${err.message}`);
    // Fallback extraction if main script evaluation failed or frame detached
    try {
      const bodyText = await evaluatePageSafe(page, () => document.body ? document.body.innerText : '');
      if (bodyText) {
        texts = bodyText.split(/\n\s*\n|\.\s+|\?\s+/).filter(s => s.trim().length > 40).slice(0, count);
      }
    } catch (_) {}
  }

  return texts || [];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MIN_MATCHES_TO_PASS = 1;
const MIN_DISTINCT_WORDS_FOR_AUTO_PASS = 2;
const STRONG_KEYWORD_OVERRIDE_COUNT = 10;

function hasSpanishContent(samples) {
  if (!samples || samples.length === 0) {
    return { found: false, details: 'No samples extracted' };
  }

  const normalize = (s) => s.normalize('NFC').toLowerCase();
  const combinedText = normalize(samples.join(' \n '));

  const foundWords = [];
  for (const word of SPANISH_WORDS) {
    const normalizedWord = normalize(word);
    const re = new RegExp(`\\b${escapeRegex(normalizedWord)}\\b`, 'i');
    if (re.test(combinedText)) {
      foundWords.push(word);
    }
  }

  return {
    found: foundWords.length >= MIN_MATCHES_TO_PASS,
    foundWords: foundWords.slice(0, 10),
    totalFound: foundWords.length,
    samplesAnalyzed: samples.length
  };
}

async function checkHtmlLangAttribute(page) {
  try {
    const lang = await page.evaluate(() => document.documentElement.lang || '');
    const trimmed = (lang || '').trim();
    const pass = /^es(-\w+)?$/i.test(trimmed);
    return { pass, value: trimmed || '(none)' };
  } catch (e) {
    return { pass: false, value: `Error: ${e.message}` };
  }
}

async function checkOgLocale(page) {
  try {
    const content = await Promise.race([
      page.$eval('meta[property="og:locale"]', el => el.getAttribute('content')).catch(() => undefined),
      new Promise((resolve) => setTimeout(() => resolve(undefined), 3000))
    ]);
    if (content === undefined || content === null || content === '') {
      return { pass: null, value: '(not present)' };
    }
    const pass = /^es[_-]/i.test(content);
    return { pass, value: content };
  } catch (e) {
    return { pass: null, value: '(not present)' };
  }
}

let _francModule = null;
async function getFranc() {
  if (!_francModule) {
    _francModule = await import('franc');
  }
  return _francModule;
}

async function detectContentLanguageFranc(text) {
  if (!text || text.trim().length < 20) {
    return { pass: null, value: 'Insufficient text', detected: 'und', confidence: 0 };
  }
  try {
    const { francAll } = await getFranc();
    const results = francAll(text, { only: ['spa', 'eng'], minLength: 20 });
    if (!results || results.length === 0 || results[0][0] === 'und') {
      return { pass: null, value: 'Undetermined', detected: 'und', confidence: 0 };
    }
    const [topLang, topScore] = results[0];
    const pass = topLang === 'spa' && topScore >= 0.9;
    return {
      pass,
      value: `${topLang} (${(topScore * 100).toFixed(0)}%)`,
      detected: topLang,
      confidence: topScore
    };
  } catch (e) {
    return { pass: null, value: `Error: ${e.message}`, detected: 'error', confidence: 0 };
  }
}

const MIN_CONFIDENCE_TO_PASS = 0.75;
const MIN_CONFIDENCE_FOR_SPANISH_URL = 0.4;

async function runLayeredValidation(page, samples, currentUrl) {
  const keywordCheck = hasSpanishContent(samples);
  const htmlLangCheck = await checkHtmlLangAttribute(page);
  const ogLocaleCheck = await checkOgLocale(page);
  const combinedText = samples.join(' \n ');
  const contentLangCheck = await detectContentLanguageFranc(combinedText);

  const urlSpanish = isSpanishUrl(currentUrl);
  const urlSignal = {
    pass: urlSpanish,
    value: currentUrl,
  };

  const signals = [
    { name: 'HTML Lang', result: htmlLangCheck },
    { name: 'OG Locale', result: ogLocaleCheck },
    { name: 'Content Detection (franc)', result: contentLangCheck },
    { name: 'Keyword Match', result: { pass: keywordCheck.found, value: `${keywordCheck.totalFound} found` } },
    { name: 'URL is Spanish', result: urlSignal },
  ];

  const applicable = signals.filter(s => s.result.pass !== null);
  const passed = applicable.filter(s => s.result.pass === true);

  const signalsTotal = applicable.length;
  const signalsPassed = passed.length;
  const confidenceScore = signalsTotal > 0 ? signalsPassed / signalsTotal : 0;

  const threshold = urlSignal.pass ? MIN_CONFIDENCE_FOR_SPANISH_URL : MIN_CONFIDENCE_TO_PASS;
  // keyword auto-pass must not override a confident English content detection or a non-Spanish URL,
  // otherwise generic shared terms can falsely pass an untranslated English page
  const autoPass = keywordCheck.totalFound >= MIN_DISTINCT_WORDS_FOR_AUTO_PASS &&
    contentLangCheck.pass !== false &&
    urlSignal.pass;

  let overallPass = autoPass || (signalsTotal > 0 && confidenceScore >= threshold);
  // franc can misclassify pages with lots of boilerplate/numeric text; only trust its "English" call
  // as an override when keyword evidence is also weak, otherwise strong keyword matches win
  if (contentLangCheck.pass === false && keywordCheck.totalFound < STRONG_KEYWORD_OVERRIDE_COUNT) {
    overallPass = false;
  }

  return {
    keywordCheck,
    htmlLangCheck,
    ogLocaleCheck,
    contentLangCheck,
    urlSignal,
    signalsPassed,
    signalsTotal,
    confidenceScore,
    overallPass,
  };
}

async function clickAndWaitForLanguagePage(page, linkHandle, debug = false) {
  const initialUrl = page.url();
  let initialContent = '';
  let targetHref = '';
  try {
    targetHref = await page.evaluate(el => el.href || '', linkHandle);
    initialContent = await page.evaluate(() => document.body.innerText.trim().slice(0, 500));
  } catch (_) {}

  console.log('   Clicking link...');
  try {
    await linkHandle.click();
  } catch (_) {
    // fall back to direct navigation if the click is blocked or stale
  }

  const navigationPromise = page.waitForNavigation({
    waitUntil: 'networkidle2',
    timeout: 10000
  }).catch(() => null);

  const urlChangePromise = page.waitForFunction(
    (url) => window.location.href !== url,
    { timeout: 10000 },
    initialUrl
  ).catch(() => null);

  const contentChangePromise = page.waitForFunction(
    (initial) => {
      const current = document.body.innerText.trim().slice(0, 500);
      if (current.length > initial.length + 100) return true;
      const spanishWords = ['protegemos', 'vehículo', 'propiedad', 'negocios', 'inversiones', 'seguro', 'cobertura', 'cotización'];
      const lower = current.toLowerCase();
      for (const w of spanishWords) {
        if (lower.includes(w)) return true;
      }
      return false;
    },
    { timeout: 15000 },
    initialContent
  ).catch(() => null);

  const result = await Promise.race([
    navigationPromise.then(() => ({ type: 'navigation', page: page })),
    urlChangePromise.then(() => ({ type: 'urlchange', page: page })),
    contentChangePromise.then(() => ({ type: 'contentchange', page: page }))
  ]).catch(() => null);

  if (result) {
    console.log(`   Navigation detected via ${result.type}`);
    return result.page;
  }

  if (targetHref) {
    try {
      console.log('   Falling back to direct href navigation to the Spanish locale URL...');
      await page.goto(targetHref, { waitUntil: 'networkidle2', timeout: 30000 });
      return page;
    } catch (_) {
      // continue below
    }
  }

  console.log('   No navigation or content change detected.');
  return null;
}

async function refreshSpanishPage(page, options = {}) {
  console.log('   Clearing browser cache...');
  await clearBrowserCache(page);

  const hasContent = !options.force && await page.evaluate(() => {
    const root = document.querySelector('app-root');
    return root && root.textContent.trim().length > 100;
  }).catch(() => false);

  if (hasContent) {
    console.log('   ℹ️  Content already loaded, skipping hard refresh.');
    return;
  }

  console.log('   Performing hard refresh (Ctrl+F5)...');
  try {
    await page.keyboard.down('Control');
    await page.keyboard.press('F5');
    await page.keyboard.up('Control');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    console.log('   ✅ Hard refresh completed.');
  } catch (refreshError) {
    // silent
  }

  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector('app-root');
        if (!root) return false;
        return root.textContent.trim().length > 100;
      },
      { timeout: 30000 }
    );
    console.log('   ✅ Content reloaded successfully.');
  } catch (_) {
    console.warn('   ⚠️  Content not visible after refresh, proceeding anyway.');
  }
}

// Angular routes can still be mid-render right after navigation/reload; retry a couple times
// if the sample looks weak before accepting it as the final content for validation.
async function extractSamplesWithRetry(page, count = SAMPLE_COUNT, debug = false, attempts = 3, delayMs = 2500) {
  let samples = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    samples = await extractMainContent(page, count, debug);
    if (debug) {
      console.log(`   Debug: attempt ${attempt} extracted ${samples.length} sample(s). Preview: ${(samples[0] || '(none)').slice(0, 200)}`);
    }
    if (samples.length === 0) continue;

    const keywordCheck = hasSpanishContent(samples);
    if (keywordCheck.totalFound >= STRONG_KEYWORD_OVERRIDE_COUNT) break;

    const combinedText = samples.join(' \n ');
    const contentLangCheck = await detectContentLanguageFranc(combinedText);
    const looksSettled = contentLangCheck.pass !== false || keywordCheck.totalFound > 0;
    if (looksSettled || attempt === attempts) break;

    console.log(`   ⏳ Content looks unsettled (attempt ${attempt}/${attempts}), waiting and re-sampling...`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  return samples;
}

async function applyLayeredValidation(page, samples, result, currentUrl) {
  const layered = await runLayeredValidation(page, samples, currentUrl);

  result.htmlLang = layered.htmlLangCheck.value + (layered.htmlLangCheck.pass === null ? '' : layered.htmlLangCheck.pass ? ' ✓' : ' ✗');
  result.ogLocale = layered.ogLocaleCheck.value + (layered.ogLocaleCheck.pass === null ? '' : layered.ogLocaleCheck.pass ? ' ✓' : ' ✗');
  result.contentDetection = layered.contentLangCheck.value + (layered.contentLangCheck.pass === null ? '' : layered.contentLangCheck.pass ? ' ✓' : ' ✗');
  result.keywordMatches = `${layered.keywordCheck.totalFound} found: ${layered.keywordCheck.foundWords.join(', ') || 'none'}`;
  result.signalsPassed = layered.signalsPassed;
  result.signalsTotal = layered.signalsTotal;
  result.confidenceScore = layered.signalsTotal > 0 ? `${(layered.confidenceScore * 100).toFixed(0)}%` : 'N/A';

  console.log(`   Signals: HTML Lang=${layered.htmlLangCheck.value} | OG Locale=${layered.ogLocaleCheck.value} | Content Detection=${layered.contentLangCheck.value} | Keywords=${layered.keywordCheck.totalFound} found | URL=${layered.urlSignal.pass ? 'Spanish' : 'English'}`);
  console.log(`   Confidence: ${layered.signalsPassed}/${layered.signalsTotal} applicable signals passed (${result.confidenceScore})`);

  if (layered.overallPass) {
    console.log('   ✅ PASS – layered validation confidence threshold met or auto-pass via keywords.');
    result.spanishTranslate = 'Pass';
    result.details = `Spanish translation validated successfully.`;
    result.status = 'PASS';
  } else {
    console.log('   ❌ FAIL – layered validation confidence threshold not met.');
    result.spanishTranslate = 'Fail';
    result.details = `Target page content remains in English (Spanish translation missing on page).`;
    result.status = 'FAIL';
  }

  return result;
}

// ============================================================
//  MODIFIED: validateSpanishConversion (accepts shared browser)
// ============================================================
async function validateSpanishConversion(url, browser, debug = false) {
  const result = {
    url,
    elementFound: 'Not Found',
    linkValid: 'N/A',
    linkHref: '',
    redirectUrl: 'N/A',
    spanishTranslate: 'Fail',
    htmlLang: 'N/A',
    ogLocale: 'N/A',
    contentDetection: 'N/A',
    keywordMatches: 'N/A',
    signalsPassed: 0,
    signalsTotal: 0,
    confidenceScore: 0,
    status: 'FAIL',
    pageError: 'N/A',
    details: ''
  };

  let page;
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    await page.setViewport({ width: 1280, height: 800 });
    // some sites serve unhydrated/English fallback content to detected headless browsers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });

    // Clear cache (best effort)
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.clearBrowserCache');
    } catch (_) {}

    console.log(`   Navigating to ${url} ...`);
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      if (!response || !response.ok()) {
        result.pageError = response ? `HTTP ${response.status()}` : 'No response';
      }
    } catch (err) {
      result.pageError = err.message;
      result.details = `Page error: ${err.message}`;
      result.status = 'FAIL';
      return result;
    }

    const isAlreadySpanish = isSpanishUrl(url);

    if (isAlreadySpanish) {
      console.log('   ℹ️  URL is already Spanish – skipping link search.');
      result.elementFound = 'N/A';
      result.linkHref = url;
      result.linkValid = 'N/A';

      await refreshSpanishPage(page);

      const samples = await extractMainContent(page, SAMPLE_COUNT, debug);
      if (samples.length === 0) {
        result.details = 'No content extracted';
        result.status = 'FAIL';
        return result;
      }

      const finalUrl = page.url();
      await applyLayeredValidation(page, samples, result, finalUrl);
      return result;
    }

    // ---- English page – find "En Español" ----
    const initialSamples = await extractMainContent(page, SAMPLE_COUNT, debug);
    const initialLayered = initialSamples.length > 0 ? await runLayeredValidation(page, initialSamples, url) : null;

    if (initialLayered && initialLayered.overallPass) {
      console.log('   ✅ Page content already meets Spanish validation signals; skipping link-only gate.');
      await applyLayeredValidation(page, initialSamples, result, url);
      return result;
    }

    console.log('   Searching for "En Español" link...');
    const linkHandle = await findEnEspanolLink(page);
    if (!linkHandle) {
      result.details = 'En Español link missing';
      result.status = 'FAIL';
      return result;
    }
    result.elementFound = 'Found';
    const href = await page.evaluate(el => el.href || '', linkHandle);
    result.linkHref = href;

    if (isValidSpanishUrl(href)) {
      console.log(`   Direct Spanish locale href detected: ${href}`);
      try {
        // click the actual link (instead of goto) so analytics click handlers fire and append their tracking params
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
          linkHandle.click()
        ]);
        result.linkValid = 'Direct Spanish href';
      } catch (_) {
        try {
          await page.goto(href, { waitUntil: 'networkidle2', timeout: 30000 });
          result.linkValid = 'Direct href failed';
        } catch (_) {}
      }
      // tracking params (e.g. _gl, _ga) are often appended asynchronously after navigation settles
      await new Promise(resolve => setTimeout(resolve, 800));
      result.redirectUrl = page.url();

      if (page.url() === url || !isValidSpanishUrl(page.url())) {
        const pageLooksSpanish = await page.evaluate(() => {
          const text = (document.body ? document.body.innerText : '').toLowerCase();
          return /(protegemos|vehículo|cotización|seguro|cobertura|contacto|servicios|atención|español|seguridad|persona|ahorro|iniciar sesión|buscar un agente|seguro de motocicleta)/i.test(text);
        }).catch(() => false);
        if (!pageLooksSpanish) {
          result.linkValid = 'Invalid';
          result.details = 'Spanish href exists but destination content is still English';
          result.status = 'FAIL';
          return result;
        }
      }

      await refreshSpanishPage(page, { force: true });
      const samples = await extractSamplesWithRetry(page, SAMPLE_COUNT, debug);
      if (samples.length === 0) {
        result.details = 'No content after direct Spanish href navigation';
        result.status = 'FAIL';
        return result;
      }

      const finalUrl = page.url();
      await applyLayeredValidation(page, samples, result, finalUrl);
      return result;
    }

    const clickInfo = await isClickable(page, linkHandle);
    if (!clickInfo.clickable) {
      try {
        await evaluatePageSafe(page, el => el.click(), linkHandle);
        result.linkValid = 'Force Clicked';
      } catch (e) {
        result.linkValid = 'Invalid';
        result.details = 'Link not clickable';
        result.status = 'FAIL';
        return result;
      }
    } else {
      result.linkValid = 'Valid';
    }

    const targetPage = await clickAndWaitForLanguagePage(page, linkHandle, debug);
    if (!targetPage) {
      result.linkValid = 'Invalid';
      result.details = 'Click did not lead to navigation';
      result.status = 'FAIL';
      return result;
    }

    // tracking params (e.g. _gl, _ga) are often appended asynchronously after navigation settles
    await new Promise(resolve => setTimeout(resolve, 800));
    let newUrl = targetPage.url();
    result.redirectUrl = newUrl;
    if (newUrl.includes('_gl=') || newUrl.includes('_gcl=')) {
      const cleanUrl = newUrl.split('?')[0];
      await targetPage.goto(cleanUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      newUrl = targetPage.url();
    }

    if (!isValidSpanishUrl(newUrl)) {
      const pageLooksSpanish = await targetPage.evaluate(() => {
        const text = (document.body ? document.body.innerText : '').toLowerCase();
        return /(protegemos|vehículo|cotización|seguro|cobertura|contacto|servicios|atención|español|seguridad|persona|ahorro)/i.test(text);
      }).catch(() => false);

      if (!pageLooksSpanish) {
        result.linkValid = 'Invalid';
        result.details = 'URL pattern mismatch after click';
        result.status = 'FAIL';
        return result;
      }

      result.details = 'Spanish content detected despite non-standard locale URL; allowing localized page.';
      result.linkValid = 'Valid (locale-based Spanish URL)';
    }

    await refreshSpanishPage(targetPage);
    const samples = await extractSamplesWithRetry(targetPage, SAMPLE_COUNT, debug);
    if (samples.length === 0) {
      result.details = 'No content after navigation';
      result.status = 'FAIL';
      return result;
    }

    const finalUrl = targetPage.url();
    await applyLayeredValidation(targetPage, samples, result, finalUrl);

  } catch (error) {
    result.details = `Unexpected error: ${error.message}`;
    result.status = 'FAIL';
    if (result.pageError === 'N/A') result.pageError = error.message;
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }

  return result;
}

// ============================================================
//  RUN WITH CONCURRENCY (replaces original runValidation)
// ============================================================
async function runValidationConcurrent(urls, debug = false, concurrency = CONCURRENCY) {
  if (concurrency > 1) {
    console.warn('⚠️  Forcing concurrency to 1 for Nationwide validation to prevent cross-page DOM race conditions and false negatives.');
    concurrency = 1;
  }

  const results = [];
  const now = new Date();
  const ts = now.getFullYear() + '-' +
             String(now.getMonth() + 1).padStart(2, '0') + '-' +
             String(now.getDate()).padStart(2, '0') + '_' +
             String(now.getHours()).padStart(2, '0') + '-' +
             String(now.getMinutes()).padStart(2, '0') + '-' +
             String(now.getSeconds()).padStart(2, '0');
  const excelPath = path.join(REPORTS_DIR, `spanish_conversion_report_${ts}.xlsx`);

  // a prior run that crashed or was killed can leave these locks behind, blocking new launches
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, lockFile)); } catch (_) {}
  }

  // Launch a single browser with persistent profile (no temp files)
  const browser = await puppeteer.launch({
    headless: !debug,
    userDataDir: PROFILE_DIR,   // <-- FIX: prevents EBUSY
    protocolTimeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process,MetricsReporting',
      '--disable-ipc-flooding-protection',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--disable-print-preview',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-speech-api',
      '--disable-sync',
      '--hide-scrollbars',
      '--ignore-gpu-blacklist',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
      '--no-pings',
      '--password-store=basic'
    ]
  });

  console.log(`🚀 Launched browser with persistent profile: ${PROFILE_DIR}`);
  console.log(`   Processing ${urls.length} URLs with concurrency ${concurrency}`);

  const closeBrowser = async () => { try { await browser.close(); } catch (_) {} };
  const onSignal = () => { closeBrowser().finally(() => process.exit(1)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // Helper to save Excel
  function saveExcel() {
    const data = results.map(r => ({
      'URL': r.url,
      'En Español Element': r.elementFound,
      'En Español Link': r.linkHref || r.linkValid,
      'Redirect Url': r.redirectUrl || 'N/A',
      'Spanish Translate': r.spanishTranslate,
      'Status': r.status,
      'Page Error': r.pageError,
      'Validation Details': r.details
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Validation');
    XLSX.writeFile(wb, excelPath);
  }

  // Process URLs with concurrency control
  let index = 0;
  const pending = [];
  let completed = 0;

  try {
  while (index < urls.length || pending.length > 0) {
    // Fill the pool
    while (pending.length < concurrency && index < urls.length) {
      const url = urls[index];
      const currentIndex = index + 1;
      console.log(`\n🔍 [${currentIndex}/${urls.length}] Starting ${url} ...`);
      const promise = validateSpanishConversion(url, browser, debug)
        .then(res => {
          results.push(res);
          completed++;
          console.log(`   ✅ [${currentIndex}/${urls.length}] Done (${res.status})`);
          if (completed % 5 === 0 || completed === urls.length) {
            try {
              saveExcel();
              console.log(`   💾 Progress saved (${completed}/${urls.length})`);
            } catch (_) {}
          }
          return res;
        })
        .catch(err => {
          console.error(`   ❌ Critical error for ${url}: ${err.message}`);
          results.push({
            url,
            elementFound: 'Not Found',
            linkValid: 'N/A',
            linkHref: '',
            redirectUrl: 'N/A',
            spanishTranslate: 'Fail',
            htmlLang: 'N/A',
            ogLocale: 'N/A',
            contentDetection: 'N/A',
            keywordMatches: 'N/A',
            signalsPassed: 0,
            signalsTotal: 0,
            confidenceScore: 0,
            status: 'FAIL',
            pageError: err.message,
            details: `Critical error: ${err.message}`
          });
          completed++;
          return null;
        })
        .finally(() => {
          const idx = pending.indexOf(promise);
          if (idx !== -1) pending.splice(idx, 1);
        });
      pending.push(promise);
      index++;
    }

    // Wait for at least one to finish
    if (pending.length > 0) {
      await Promise.race(pending);
    }
  }

  // Final save
  saveExcel();
  console.log(`\n✅ All ${urls.length} URL(s) processed. Final report: ${excelPath}`);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await closeBrowser();
    console.log('🔒 Browser closed.');
  }
}

// ============================================================
//  ENTRY POINT
// ============================================================
async function main() {
  const { urls, debug, concurrency } = parseArguments();
  console.log(`📋 Validating ${urls.length} URL(s) with concurrency ${concurrency}`);
  if (debug) console.log('🐞 Debug mode: browser visible');
  await runValidationConcurrent(urls, debug, concurrency);
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  runValidationConcurrent,
  isSpanishUrl,
  isValidSpanishUrl,
  runLayeredValidation,
  hasSpanishContent
};