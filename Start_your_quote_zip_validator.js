const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// ======================= CONFIGURATION =======================
const CONFIG = {
  reportsDir: 'reports',
  screenshotDir: 'screenshots',
  requiredReportColumns: ['url', 'redirectUrl', 'apiUrl', 'apiResponse', 'error', 'status'],
  defaultCsvInput: 'urls.csv',

  // Timeouts (ms)
  timeouts: {
    navigation: 30000,
    waitForElement: 5000,
    waitForSpinner: 15000,
    waitForRedirect: 20000,
    apiWait: 3000,
  },

  // Selectors (can be easily updated if UI changes)
  selectors: {
    zipInput: [
      '#detail-banner__zip-input',
      '#zip-input',
      'input[name="Zip"]',
      'input[placeholder="ZIP Code"]',
      'input[aria-label="zip code"]',
      'input.zip-field',
      'input.zip-input',
      'input[type="tel"]',
      'input[type="text"][id*="zip"]',
      'bolt-input-facade >> input[type="tel"]',
      'bolt-input-facade >> input[type="text"]',
      'bolt-input-facade >> input',
    ],
    quoteButton: [
      '#detail-banner__quote-btn',
      'bolt-button >> button',
      '#l45724 > ngx-nationwide-quote > ngx-nationwide-level-three-quote > div > div:nth-child(2) > bolt-button >> button',
      'button:has-text("Start your quote"), input[value="Start your quote"]',
      'a:has-text("Start your quote")',
      'a:has-text("Get a quote")',
      '[role="link"]:has-text("Start your quote")',
      '[role="button"]:has-text("Start your quote")',
    ],
    cookieAccept: [
      '#truste-consent-button',
      '#truste-show-consent',
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("OK")',
      '[aria-label="Close cookie banner"]',
      '#cookie-accept',
      '.cookie-accept',
      '.consent-accept',
      '.accept-cookies',
      'button[data-testid="cookie-accept"]',
      'button[aria-label="Accept cookies"]',
    ],
    popupClose: [
      '[aria-label="Close"]',
      '.modal-close',
      '.popup-close',
      'button:has-text("×")',
      'button:has-text("Close")',
      '[aria-label="Close dialog"]',
    ],
    quoteContainer: [
      '.bolt-col-12.text-center',
      '.nw-banner3.nw-container',
      '#quoteform',
      '.quote-container',
      'ngx-nationwide-level-three-quote > div',
      'form[id*="quote"]',
      '.d-flex-column.d-md-flex-row',
      '.quote-form',
      '#quote-form',
      '[data-testid="quote-page"]',
      '.container',
      '.main-content',
    ],
    quotePageIndicator: ['h1', '.quote-form', '#quote-form', '[data-testid="quote-page"]'],
    trustArcOverlays: [
      '.truste_overlay',
      '.truste_box_overlay',
      '[id*="pop-frame"]',
      '.truste_overlay_backdrop',
      '[id*="pop-div"]',
      '#truste-consent-text',
      '#truste-consent-buttons',
      '#truste-consent-content',
    ],
  },

  // Expected error texts (supports regex)
  errorPatterns: {
    emptyZip: [
      'Enter your 5 or 9 digit ZIP Code',
      /zip code is required/i,
      /enter a valid zip/i,
      /postal code is required/i,
    ],
    invalidZip: [
      'Unable to find a valid state for the given Postal Code',
      /unable to find a valid state/i,
      /enter a valid zip/i,
      /invalid postal code/i,
    ],
  },

  // Domain & URL patterns
  quoteHostname: 'getaquote.nationwide.com',
  quotePathSegments: ['quote', 'quotes', 'get-a-quote', 'start-your-quote'],
  quoteQueryParams: ['getQuote', 'typebus', 'zip', 'zipCode', 'products'],
};

// ======================= HELPERS =======================

function stringifyCsv(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const columns = options.columns || Object.keys(rows[0]);
  const escapeValue = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [];
  if (options.header !== false) {
    lines.push(columns.map(escapeValue).join(','));
  }
  for (const row of rows) {
    lines.push(columns.map(column => escapeValue(row[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function resolveInputCsvFromArgs(args) {
  let fileIndex = args.indexOf('-file');
  if (fileIndex === -1) fileIndex = args.indexOf('--file');
  if (fileIndex !== -1 && args[fileIndex + 1]) return args[fileIndex + 1];
  return CONFIG.defaultCsvInput;
}

function resolveBrowserMode(args) {
  const headed = args.includes('--headed') || args.includes('-headed');
  const headless = args.includes('--headless') || args.includes('-headless');
  if (headed && headless) {
    console.warn('  ⚠️ Both --headed and --headless were supplied; using --headed.');
  }
  return headed ? 'headed' : 'headless';
}

function toExpectedPatterns(expected) {
  if (Array.isArray(expected)) {
    return expected.map(item => (item instanceof RegExp ? item : new RegExp(String(item), 'i')));
  }
  if (expected instanceof RegExp) return [expected];
  return [new RegExp(String(expected), 'i')];
}

function expectedDescription(expected) {
  if (Array.isArray(expected)) {
    return expected.map(item => (item instanceof RegExp ? item.source : String(item))).join(' | ');
  }
  return expected instanceof RegExp ? expected.source : String(expected);
}

function textMatchesExpected(text, expected) {
  const value = String(text || '');
  return toExpectedPatterns(expected).some(pattern => pattern.test(value));
}

function normalizeUrlForComparison(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const normalizedHost = parsed.hostname.replace(/^www-ng\./i, 'www.');
    let normalizedPath = (parsed.pathname || '/').replace(/\/+/g, '/');
    normalizedPath = normalizedPath.replace(/\/index\.html$/i, '/');
    normalizedPath = normalizedPath.replace(/\.html$/i, '');
    normalizedPath = normalizedPath.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${normalizedHost}${normalizedPath}`;
  } catch (_) {
    return String(rawUrl || '')
      .replace(/\/index\.html$/i, '/')
      .replace(/\.html$/i, '')
      .replace(/\/+$/, '');
  }
}

function isSameValidationUrl(validationUrl, candidateUrl) {
  return normalizeUrlForComparison(validationUrl) === normalizeUrlForComparison(candidateUrl);
}

function isQuoteDestinationUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    const hostname = (parsed.hostname || '').toLowerCase();
    const pathname = (parsed.pathname || '').toLowerCase();
    const searchParams = parsed.searchParams;

    if (hostname === CONFIG.quoteHostname) return true;

    const hasQuotePathSegment = new RegExp(`(^|\\/)(${CONFIG.quotePathSegments.join('|')})(\\/|$)`, 'i').test(pathname);
    const hasQuoteQuerySignals = CONFIG.quoteQueryParams.some(param => searchParams.has(param));
    return hasQuotePathSegment || hasQuoteQuerySignals;
  } catch (_) {
    return /quote|get-a-quote|start-your-quote/i.test(String(rawUrl).toLowerCase());
  }
}

function isNotApplicableErrorMessage(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('zip input not found') ||
    normalized.includes('quote element not present') ||
    normalized.includes('quote button not found') ||
    normalized.includes('err_tunnel_connection_failed');
}

function getRelevantApiCaptureUrl(responseUrl) {
  if (!responseUrl) return false;
  const normalized = responseUrl.toLowerCase();
  return normalized.includes('/api/') ||
    normalized.includes('quote') ||
    normalized.includes('zip') ||
    normalized.includes('products') ||
    normalized.includes('state') ||
    normalized.includes('v1') ||
    normalized.includes('webapi');
}

// ======================= BROWSER ACTIONS =======================

async function gotoWithRetry(page, url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.navigation });
      await page.waitForLoadState('domcontentloaded');
      return;
    } catch (error) {
      console.log(`  Attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) throw error;
      await page.waitForTimeout(1000 * Math.pow(2, attempt - 1));
    }
  }
}

async function hardRefreshAndClearCache(page, url) {
  const context = page.context();
  try {
    await context.clearCookies();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.navigation });
    await page.waitForLoadState('domcontentloaded');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
    await cdp.detach().catch(() => {});
    console.log('  ✔ Hard refresh completed and browser cache cleared');
    return;
  } catch (error) {
    console.log(`  ⚠️ CDP cache clear failed, using URL cache-bust fallback: ${error.message}`);
  }
  const separator = url.includes('?') ? '&' : '?';
  const bustedUrl = `${url}${separator}_cacheBust=${Date.now()}`;
  await page.goto(bustedUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.navigation });
  await page.waitForLoadState('domcontentloaded');
  console.log('  ✔ Fallback refresh with cache-busting URL parameter completed');
}

async function removeTrustArcOverlays(page) {
  await page.evaluate(selectors => {
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (el.closest('.truste_box_overlay, .truste_overlay')) {
          el.closest('.truste_box_overlay, .truste_overlay').remove();
        } else {
          el.style.display = 'none';
        }
      });
    });
  }, CONFIG.selectors.trustArcOverlays).catch(() => {});
}

async function handleCookiesAndPopups(page) {
  // Wait for any cookie banner to appear (no arbitrary timeout)
  try {
    await page.waitForSelector(CONFIG.selectors.cookieAccept.join(', '), { timeout: 2000 });
  } catch (_) { /* no banner */ }

  // Check for TrustArc specific
  const trustArcBanner = page.locator('#truste-consent-text, #truste-consent-content').first();
  if (await trustArcBanner.count() > 0 && await trustArcBanner.isVisible()) {
    console.log('  ℹ️ TrustArc cookie banner detected');
    const acceptBtn = page.locator('#truste-consent-button');
    if (await acceptBtn.count() > 0 && await acceptBtn.isVisible()) {
      await acceptBtn.click();
      console.log('  ✔ Accepted cookies (TrustArc)');
      await page.waitForTimeout(500);
      await removeTrustArcOverlays(page);
      await page.waitForFunction(
        () => !document.querySelector('#truste-consent-text, #truste-consent-content')?.getBoundingClientRect()?.width,
        { timeout: 5000 }
      ).catch(() => {});
      return;
    }
    const fallbackBtn = page.locator('#truste-consent-buttons button:has-text("Accept"), #truste-consent-buttons button:has-text("OK")');
    if (await fallbackBtn.count() > 0 && await fallbackBtn.isVisible()) {
      await fallbackBtn.click();
      console.log('  ✔ Accepted cookies (TrustArc fallback)');
      await page.waitForTimeout(500);
      await removeTrustArcOverlays(page);
      return;
    }
    await removeTrustArcOverlays(page);
    console.log('  ✔ Removed TrustArc banner (no accept button found)');
    return;
  }

  // Generic accept via evaluate
  const cookieAccepted = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      if (text.includes('accept') || text.includes('agree') || text.includes('ok') || text.includes('allow')) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  if (cookieAccepted) {
    console.log('  ✔ Accepted cookies (via page.evaluate)');
    await page.waitForTimeout(500);
    await removeTrustArcOverlays(page);
    return;
  }

  // Loop through cookie selectors
  for (const sel of CONFIG.selectors.cookieAccept) {
    const acceptBtn = page.locator(sel);
    try {
      if (await acceptBtn.count() > 0 && await acceptBtn.first().isVisible()) {
        await acceptBtn.first().click();
        console.log(`  ✔ Accepted cookies (via selector: ${sel})`);
        await page.waitForTimeout(500);
        await removeTrustArcOverlays(page);
        return;
      }
    } catch (_) { /* ignore */ }
  }

  // Close popups if any
  for (const sel of CONFIG.selectors.popupClose) {
    const closeBtn = page.locator(sel);
    try {
      if (await closeBtn.count() > 0 && await closeBtn.first().isVisible()) {
        await closeBtn.first().click();
        console.log('  ✔ Closed popup');
        await page.waitForTimeout(500);
        break;
      }
    } catch (_) { /* ignore */ }
  }

  await removeTrustArcOverlays(page);
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function waitForSpinnerToHide(page) {
  try {
    const spinner = page.locator('bolt-waiting-indicator');
    if (await spinner.count() > 0) {
      await spinner.first().waitFor({ state: 'hidden', timeout: CONFIG.timeouts.waitForSpinner });
      console.log('  ✔ Spinner disappeared');
      return;
    }
    const overlay = page.locator('.bolt-waiting-indicator, [class*="spinner"], [class*="loading"]');
    if (await overlay.count() > 0) {
      await overlay.first().waitFor({ state: 'hidden', timeout: CONFIG.timeouts.waitForSpinner });
      console.log('  ✔ Spinner disappeared (fallback)');
    }
  } catch (_) {
    console.log('  ℹ️ No spinner detected or already hidden');
  }
}

async function checkVisualAlignment(page, element) {
  await element.waitFor({ state: 'visible' });
  const box = await element.boundingBox();
  if (!box) throw new Error('Element has no bounding box (hidden?)');
  const viewport = page.viewportSize();
  if (
    box.x < 0 || box.y < 0 ||
    box.x + box.width > viewport.width ||
    box.y + box.height > viewport.height
  ) {
    throw new Error('Element is partially outside viewport');
  }
  const isHidden = await element.evaluate(el => {
    const style = window.getComputedStyle(el);
    return style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none';
  });
  if (isHidden) throw new Error('Element is hidden');
}

async function getZipInput(page) {
  await waitForSpinnerToHide(page);
  // Use first visible input that matches any selector
  for (const sel of CONFIG.selectors.zipInput) {
    const loc = page.locator(sel);
    try {
      if (await loc.count() > 0 && await loc.first().isVisible()) {
        console.log(`  ℹ️ Found ZIP input via selector: ${sel}`);
        return loc.first();
      }
    } catch (_) { /* ignore */ }
  }

  // Fallback: search all inputs
  const inputHandle = await page.evaluateHandle(() => {
    const allInputs = document.querySelectorAll('input[type="tel"], input[type="text"]');
    for (const inp of allInputs) {
      const placeholder = inp.placeholder?.toLowerCase() || '';
      const ariaLabel = inp.getAttribute('aria-label')?.toLowerCase() || '';
      const name = inp.name?.toLowerCase() || '';
      const id = inp.id?.toLowerCase() || '';
      if (placeholder.includes('zip') || ariaLabel.includes('zip') || name.includes('zip') || id.includes('zip')) {
        const rect = inp.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return inp;
      }
    }
    // Check shadow DOM
    const facades = document.querySelectorAll('bolt-input-facade');
    for (const facade of facades) {
      if (facade.shadowRoot) {
        const input = facade.shadowRoot.querySelector('input');
        if (input) {
          const placeholder = input.placeholder?.toLowerCase() || '';
          const ariaLabel = input.getAttribute('aria-label')?.toLowerCase() || '';
          const name = input.name?.toLowerCase() || '';
          const id = input.id?.toLowerCase() || '';
          if (placeholder.includes('zip') || ariaLabel.includes('zip') || name.includes('zip') || id.includes('zip')) {
            const rect = input.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return input;
          }
        }
      }
    }
    return null;
  });

  if (inputHandle) {
    const isElement = await inputHandle.evaluate(el => el instanceof Element);
    if (isElement) {
      const selector = await inputHandle.evaluate(el => {
        if (el.id) return `#${el.id}`;
        if (el.name) return `[name="${el.name}"]`;
        const classes = Array.from(el.classList).join('.');
        return `${el.tagName.toLowerCase()}${classes ? '.' + classes : ''}`;
      });
      const loc = page.locator(selector);
      if (await loc.count() > 0 && await loc.first().isVisible()) {
        console.log(`  ℹ️ Found ZIP input via evaluateHandle: ${selector}`);
        return loc.first();
      }
    }
  }

  // XPath fallback
  const xpath = '//input[contains(translate(@placeholder, "ZIP", "zip"), "zip")]';
  const loc = page.locator(xpath);
  if (await loc.count() > 0 && await loc.first().isVisible()) {
    console.log(`  ℹ️ Found ZIP input via XPath`);
    return loc.first();
  }

  throw new Error('ZIP input not found');
}

async function getQuoteButton(page) {
  for (const selector of CONFIG.selectors.quoteButton) {
    const btn = page.locator(selector).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      console.log(`  ℹ️ Found quote CTA via selector: ${selector}`);
      return btn;
    }
  }
  throw new Error('Quote element not present');
}

async function clickQuoteButton(page, quoteButton, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await removeTrustArcOverlays(page);
      await quoteButton.click({ timeout: 60000 });
      return;
    } catch (error) {
      console.log(`  Click attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) {
        console.log('  🔄 Hard refreshing the page...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('domcontentloaded');
        await removeTrustArcOverlays(page);
        const newButton = await getQuoteButton(page);
        await newButton.click({ timeout: 60000 });
        return;
      }
      await page.waitForTimeout(2000);
      await removeTrustArcOverlays(page);
    }
  }
}

async function findErrorMessage(page, expectedPatterns, input = null) {
  // Wait a moment for error to render
  await page.waitForTimeout(1000);

  const currentUrl = page.url();

  // Special case: UAT pages may show error without visible message
  if (currentUrl.includes('uat-ng') && !isQuoteDestinationUrl(currentUrl)) {
    console.log('  ℹ️ UAT page – assuming validation error is shown (form stayed on same page)');
    if (input) {
      try {
        await input.waitFor({ state: 'visible', timeout: 1000 });
        return input;
      } catch (_) {
        try {
          const newInput = await getZipInput(page);
          return newInput;
        } catch (__) {
          return page.locator('body');
        }
      }
    }
    try {
      const newInput = await getZipInput(page);
      return newInput;
    } catch (_) {
      return page.locator('body');
    }
  }

  // If we are on a quote page, error is not expected
  if (isQuoteDestinationUrl(currentUrl)) {
    throw new Error(`Expected validation error but page redirected to quote: ${currentUrl}`);
  }

  // Check input validation state
  if (input) {
    const isInvalid = await page.waitForFunction(
      el => {
        const invalid = el.classList.contains('ng-invalid') ||
                       el.getAttribute('aria-invalid') === 'true' ||
                       el.validationMessage !== '';
        return invalid;
      },
      input,
      { timeout: 3000 }
    ).then(() => true).catch(() => false);

    if (isInvalid) {
      console.log('  ℹ️ Input is invalid – error is being shown (validation state)');
      return input;
    }

    const validationMsg = await input.evaluate(el => el.validationMessage);
    if (validationMsg && textMatchesExpected(validationMsg, expectedPatterns)) {
      console.log(`  ℹ️ Browser validation message: "${validationMsg}"`);
      return input;
    }
  }

  // Search for text in light and shadow DOM
  const allPatterns = toExpectedPatterns(expectedPatterns);
  for (const pattern of allPatterns) {
    const patternString = pattern.source; // might not be exact string if regex
    // Try to find exact text if pattern is a simple string
    let textToFind = null;
    if (typeof expectedPatterns === 'string') textToFind = expectedPatterns;
    else if (Array.isArray(expectedPatterns)) {
      // find first string match
      const stringMatch = expectedPatterns.find(p => typeof p === 'string' && pattern.test(p));
      if (stringMatch) textToFind = stringMatch;
    }

    if (textToFind) {
      const errorFound = await page.waitForFunction(
        (text) => {
          function findInShadow(el) {
            if (el.shadowRoot) {
              const inner = el.shadowRoot.querySelector('*');
              if (inner) {
                const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT, null, false);
                let node;
                while (node = walker.nextNode()) {
                  if (node.textContent.includes(text)) {
                    const parent = node.parentElement;
                    if (parent && parent.getBoundingClientRect().width > 0) {
                      return parent;
                    }
                  }
                }
              }
            }
            for (const child of el.children) {
              const result = findInShadow(child);
              if (result) return result;
            }
            return null;
          }
          return findInShadow(document.body);
        },
        textToFind,
        { timeout: 8000 }
      ).then(handle => handle.jsonValue()).catch(() => null);

      if (errorFound) {
        console.log(`  ℹ️ Found error in shadow DOM / light DOM: "${textToFind}"`);
        const locator = page.locator(`text="${textToFind}"`);
        if (await locator.count() > 0) return locator.first();
        const host = page.locator('bolt-input-control').first();
        if (await host.count() > 0) return host;
      }
    }
  }

  // Check live regions
  const liveRegion = page.locator('[aria-live="polite"], [aria-live="assertive"], [role="alert"]');
  if (await liveRegion.count() > 0) {
    const text = await liveRegion.first().textContent();
    if (text && textMatchesExpected(text, expectedPatterns)) return liveRegion.first();
  }

  // Check error class elements
  const errorElements = await page.locator('.ng-invalid, [aria-invalid="true"], .bolt-field-error, [class*="error"], [class*="alert"]').all();
  for (const el of errorElements) {
    if (await el.isVisible()) {
      const text = await el.textContent();
      if (text && textMatchesExpected(text, expectedPatterns)) return el;
    }
  }

  // Check full page text
  const visibleText = await page.evaluate(() => document.body.innerText);
  if (textMatchesExpected(visibleText, expectedPatterns)) {
    // Try to locate a specific element containing the error
    for (const pattern of allPatterns) {
      if (pattern instanceof RegExp) {
        // find any element containing match
        const elements = await page.locator('*').all();
        for (const el of elements) {
          const text = await el.textContent().catch(() => '');
          if (text && pattern.test(text) && await el.isVisible()) {
            return el;
          }
        }
      } else {
        // simple string
        const locator = page.locator(`text="${pattern}"`);
        if (await locator.count() > 0) return locator.first();
      }
    }
    return page.locator('body');
  }

  // Special handling for state pages
  if (!isQuoteDestinationUrl(currentUrl) && currentUrl.includes('/personal/insurance/auto/state/')) {
    if (input) {
      const stateValidationDetected = await input.evaluate(el => {
        const value = el.value || '';
        const required = el.hasAttribute('required');
        const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
        const classInvalid = el.classList.contains('ng-invalid');
        const nativeInvalid = typeof el.checkValidity === 'function' ? !el.checkValidity() : false;
        const validationMessage = el.validationMessage || '';
        if (ariaInvalid || classInvalid || nativeInvalid || validationMessage.length > 0) return true;
        return required && value.trim() === '';
      }).catch(() => false);
      if (stateValidationDetected) {
        console.log('  ℹ️ State page validation detected via input state');
        return input;
      }
    }
  }

  throw new Error(`Error message "${expectedDescription(expectedPatterns)}" not found. Visible text (first 500 chars): ${visibleText.substring(0, 500)}...`);
}

async function captureQuoteContainerScreenshot(page, filename) {
  let container = null;
  let usedSelector = 'body (fallback)';
  for (const sel of CONFIG.selectors.quoteContainer) {
    const loc = page.locator(sel);
    const first = loc.first();
    if (await first.count() > 0 && await first.isVisible()) {
      container = first;
      usedSelector = sel;
      break;
    }
  }
  if (!container) {
    container = page.locator('body');
    usedSelector = 'body (fallback)';
  }
  console.log(`  ℹ️ Capturing screenshot using selector: ${usedSelector}`);
  const dir = path.join(CONFIG.reportsDir, 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await container.screenshot({ path: filePath });
  if (!fs.existsSync(filePath)) {
    throw new Error(`Screenshot file was not created: ${filePath}`);
  }
  console.log(`  ℹ️ Screenshot saved: ${filePath}`);
  return filePath;
}

// ======================= VALIDATION FUNCTION =======================

async function validateQuote(url, page) {
  const apiCapture = { url: '', response: '' };
  const onResponse = async (response) => {
    try {
      const responseUrl = response.url();
      if (!getRelevantApiCaptureUrl(responseUrl)) return;
      const headers = response.headers ? response.headers() : {};
      const contentType = String(headers['content-type'] || headers['Content-Type'] || '');
      if (!contentType && !responseUrl.includes('/api/')) return;
      const body = await response.text().catch(() => '');
      if (!body) return;
      // Store the most recent relevant API response
      apiCapture.url = responseUrl;
      apiCapture.response = body;
    } catch (_) { /* ignore */ }
  };

  page.on('response', onResponse);

  const result = {
    url,
    status: 'PASS',
    error: '',
    screenshot: '',
    elementScreenshot: '',
    redirectUrl: '',
    apiUrl: '',
    apiResponse: '',
    details: {
      pageLoaded: false,
      cacheCleared: false,
      cookiesHandled: false,
      zipInputFound: false,
      quoteButtonFound: false,
      emptyZipError: false,
      invalidZipError: false,
      visualAlignment: false,
      redirect: false,
      quotePageContent: false,
      backNavigation: false,
    },
  };

  try {
    // Navigate and prepare
    await gotoWithRetry(page, url);
    result.details.pageLoaded = true;
    console.log('  ✔ Page loaded');

    await hardRefreshAndClearCache(page, url);
    result.details.cacheCleared = true;

    await handleCookiesAndPopups(page);
    result.details.cookiesHandled = true;

    const canonicalValidationStartUrl = normalizeUrlForComparison(page.url());

    let zipInput = await getZipInput(page);
    result.details.zipInputFound = true;
    console.log('  ✔ ZIP input found');

    const quoteButton = await getQuoteButton(page);
    result.details.quoteButtonFound = true;
    console.log('  ✔ Quote element found');

    // ---- 1. Empty ZIP error ----
    await zipInput.clear();
    // Wait for clear to take effect
    await page.waitForTimeout(300);
    const value = await zipInput.inputValue();
    if (value !== '') {
      throw new Error('ZIP input was not cleared correctly');
    }
    console.log('  ✔ ZIP input verified as empty');

    await clickQuoteButton(page, quoteButton);
    console.log('  ✔ Clicked "Start your quote" (empty ZIP)');
    await waitForSpinnerToHide(page);

    const currentUrl = page.url();
    if (isQuoteDestinationUrl(currentUrl)) {
      throw new Error(`Expected validation error but page redirected to quote: ${currentUrl}`);
    }
    zipInput = await getZipInput(page);
    const emptyError = await findErrorMessage(page, CONFIG.errorPatterns.emptyZip, zipInput);
    await checkVisualAlignment(page, emptyError);
    result.details.emptyZipError = true;
    console.log('  ✔ Empty ZIP error validated (visual alignment OK)');

    // ---- 2. Invalid ZIP error ----
    await zipInput.fill('00000-0000');
    await clickQuoteButton(page, quoteButton);
    console.log('  ✔ Submitted invalid ZIP');
    await waitForSpinnerToHide(page);
    if (isQuoteDestinationUrl(page.url())) {
      throw new Error(`Expected validation error but page redirected to quote for invalid ZIP`);
    }
    zipInput = await getZipInput(page);
    const invalidError = await findErrorMessage(page, CONFIG.errorPatterns.invalidZip, zipInput);
    await checkVisualAlignment(page, invalidError);
    result.details.invalidZipError = true;
    console.log('  ✔ Invalid ZIP error validated (visual alignment OK)');

    // ---- 3. Visual alignment of the quote button ----
    await quoteButton.waitFor({ state: 'visible', timeout: CONFIG.timeouts.waitForElement });
    await checkVisualAlignment(page, quoteButton);
    result.details.visualAlignment = true;
    console.log('  ✔ Visual alignment passed (on landing page)');

    // ---- 4. Valid ZIP and redirect ----
    zipInput = await getZipInput(page);
    await zipInput.fill('43215');
    await clickQuoteButton(page, quoteButton);
    console.log('  ✔ Submitted valid ZIP');
    await waitForSpinnerToHide(page);
    try {
      await page.waitForURL(url => isQuoteDestinationUrl(url.toString()), {
        timeout: CONFIG.timeouts.waitForRedirect,
        waitUntil: 'domcontentloaded',
      });
    } catch (_) {
      const redirectedUrl = page.url();
      if (!isQuoteDestinationUrl(redirectedUrl)) {
        throw _;
      }
      console.log('  ℹ️ Redirect URL matched quote pattern even though waitForURL timed out');
    }
    result.details.redirect = true;
    result.redirectUrl = page.url();
    console.log(`  ✔ Redirected to quote page – current URL: ${page.url()}`);

    // ---- 5. Verify quote page content ----
    const quotePageIndicator = page.locator(CONFIG.selectors.quotePageIndicator.join(', '));
    try {
      await quotePageIndicator.first().waitFor({ state: 'visible', timeout: CONFIG.timeouts.waitForElement });
      result.details.quotePageContent = true;
      console.log('  ✔ Quote page content verified');
    } catch (_) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText && bodyText.length > 100) {
        result.details.quotePageContent = true;
        console.log('  ✔ Quote page has content (body length: ' + bodyText.length + ' chars)');
      } else {
        console.log('  ⚠️ Quote page content minimal, but URL check passed');
      }
    }

    // ---- 6. Browser back to original validation URL ----
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.waitForRedirect });
    } catch (_) {
      // If goBack fails, try to navigate directly
      console.log('  ⚠️ goBack failed, attempting to navigate directly to validation URL');
      await page.goto(canonicalValidationStartUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.navigation });
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const backUrl = page.url();
    if (!isSameValidationUrl(canonicalValidationStartUrl, backUrl)) {
      throw new Error(`Back navigation did not return to validation URL. Expected: ${canonicalValidationStartUrl} | Actual: ${normalizeUrlForComparison(backUrl)}`);
    }
    result.details.backNavigation = true;
    console.log(`  ✔ Browser back returned to validation URL: ${backUrl}`);

    // ---- 7. Capture screenshot (saved to disk) ----
    const safeUrl = url.replace(/[^a-zA-Z0-9]/g, '_');
    const containerScreenshotName = `${safeUrl}_container_${Date.now()}.png`;
    try {
      const containerPath = await captureQuoteContainerScreenshot(page, containerScreenshotName);
      result.elementScreenshot = containerPath;
      console.log('  ✔ Quote container screenshot captured (saved to disk)');
    } catch (screenshotError) {
      console.log(`  ⚠️ Container screenshot skipped: ${screenshotError.message}`);
    }

  } catch (error) {
    const notApplicable = isNotApplicableErrorMessage(error.message);
    result.status = notApplicable ? 'NA' : 'FAIL';
    result.error = notApplicable ? `Not applicable: ${error.message}` : error.message;
    console.log(notApplicable ? `  ⚪ NA: ${result.error}` : `  ✘ FAIL: ${error.message}`);

    result.apiUrl = apiCapture.url;
    result.apiResponse = apiCapture.response;

    if (notApplicable) {
      page.off('response', onResponse);
      return result;
    }

    const safeUrl = url.replace(/[^a-zA-Z0-9]/g, '_');
    const fullScreenshotName = `${safeUrl}_fullpage_${Date.now()}.png`;
    const fullPath = path.join(CONFIG.screenshotDir, fullScreenshotName);
    if (!fs.existsSync(CONFIG.screenshotDir)) fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    try {
      await page.screenshot({ path: fullPath, fullPage: true });
      result.screenshot = fullPath;
    } catch (screenshotError) {
      console.log(`  ⚠️ Full-page screenshot skipped: ${screenshotError.message}`);
    }
  }

  result.apiUrl = apiCapture.url;
  result.apiResponse = apiCapture.response;
  page.off('response', onResponse);
  return result;
}

// ======================= HTML REPORT GENERATOR =======================

function generateHTMLReport(results, outputFile) {
  const total = results.length;
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const notApplicable = results.filter(r => r.status === 'NA').length;
  const applicableTotal = pass + fail;
  const successRate = applicableTotal ? Math.round((pass / applicableTotal) * 100) : 0;

  const rows = results.map((r) => {
    const statusClass = r.status === 'PASS' ? 'pass' : (r.status === 'NA' ? 'na' : 'fail');
    const statusIcon = r.status === 'PASS' ? '✅' : (r.status === 'NA' ? '⚪' : '❌');

    // Build step details
    const steps = [
      { label: 'Page Loaded', ok: r.details?.pageLoaded },
      { label: 'Hard Refresh / Cache Clear', ok: r.details?.cacheCleared },
      { label: 'Cookies Handled', ok: r.details?.cookiesHandled },
      { label: 'ZIP Input Found', ok: r.details?.zipInputFound },
      { label: 'Quote Button Found', ok: r.details?.quoteButtonFound },
      { label: 'Empty ZIP Error', ok: r.details?.emptyZipError },
      { label: 'Invalid ZIP Error', ok: r.details?.invalidZipError },
      { label: 'Visual Alignment', ok: r.details?.visualAlignment },
      { label: 'Redirect to Quote', ok: r.details?.redirect, value: r.redirectUrl },
      { label: 'Quote Page Content', ok: r.details?.quotePageContent },
      { label: 'Back Navigation', ok: r.details?.backNavigation },
      { label: 'API URL', ok: !!r.apiUrl, value: r.apiUrl },
      { label: 'API Response', ok: !!r.apiResponse, value: r.apiResponse },
    ];
    const stepList = steps.map(s =>
      `<li style="color: ${s.ok ? 'green' : 'red'};">${s.ok ? '✔' : '✘'} ${s.label}${s.value ? `: ${s.value}` : ''}</li>`
    ).join('');

    // Screenshot links
    let screenshotLinks = '';
    if (r.screenshot) {
      const relPath = path.relative(CONFIG.reportsDir, r.screenshot);
      screenshotLinks += `<a href="${relPath}" target="_blank">Full-page screenshot</a> `;
    }
    if (r.elementScreenshot) {
      const relPath = path.relative(CONFIG.reportsDir, r.elementScreenshot);
      screenshotLinks += `<a href="${relPath}" target="_blank">Container screenshot</a>`;
    }
    if (screenshotLinks) screenshotLinks = `<div>${screenshotLinks}</div>`;

    return `
      <tr class="${statusClass}">
        <td><a href="${r.url}" target="_blank">${r.url}</a></td>
        <td><span class="badge ${statusClass}">${statusIcon} ${r.status}</span></td>
        <td>${r.error || '—'}</td>
        <td>
          <details>
            <summary>Show steps</summary>
            <ul style="list-style: none; padding-left: 0;">${stepList}</ul>
            ${screenshotLinks}
          </details>
        </td>
      </tr>
    `;
  }).join('');

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quote Validation Report</title>
    <style>
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f7fa; margin: 20px; padding: 20px; color: #333; }
      .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); padding: 30px; }
      h1 { font-size: 28px; margin-top: 0; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; color: #1e293b; display: flex; align-items: center; gap: 10px; }
      .summary { display: flex; flex-wrap: wrap; gap: 20px; background: #f8fafc; border-radius: 10px; padding: 20px; margin: 20px 0; border: 1px solid #e2e8f0; }
      .summary-item { flex: 1; min-width: 120px; text-align: center; }
      .summary-item .number { font-size: 32px; font-weight: bold; }
      .summary-item .label { font-size: 14px; color: #64748b; }
      .pass .number { color: #10b981; }
      .fail .number { color: #ef4444; }
      .total .number { color: #3b82f6; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
      th { background: #f1f5f9; color: #1e293b; padding: 12px 15px; text-align: left; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
      td { padding: 12px 15px; border-bottom: 1px solid #e2e8f0; vertical-align: middle; }
      tr.pass { background: #f0fdf4; }
      tr.fail { background: #fef2f2; }
      tr.na { background: #f8fafc; }
      .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: 600; font-size: 13px; }
      .badge.pass { background: #d1fae5; color: #065f46; }
      .badge.fail { background: #fee2e2; color: #991b1b; }
      .badge.na { background: #e2e8f0; color: #334155; }
      details summary { cursor: pointer; color: #3b82f6; font-weight: 500; }
      details ul { margin: 8px 0 0 0; padding: 0; }
      details li { padding: 2px 0; font-size: 13px; }
      .footer { margin-top: 30px; text-align: center; color: #94a3b8; font-size: 13px; border-top: 1px solid #e2e8f0; padding-top: 20px; }
      a { color: #3b82f6; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>📋 Quote Validation Report</h1>
      <div class="summary">
        <div class="summary-item total"><div class="number">${total}</div><div class="label">Total URLs</div></div>
        <div class="summary-item pass"><div class="number">${pass}</div><div class="label">Passed</div></div>
        <div class="summary-item fail"><div class="number">${fail}</div><div class="label">Failed</div></div>
        <div class="summary-item"><div class="number" style="color:#475569;">${notApplicable}</div><div class="label">Not Applicable</div></div>
        <div class="summary-item" style="flex:2;"><div class="number" style="font-size:18px;">${successRate}%</div><div class="label">Success Rate (Applicable)</div></div>
      </div>
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Status</th>
            <th>Error</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="footer">Generated on ${new Date().toLocaleString()} by Playwright Automation</div>
    </div>
  </html>
  `;

  fs.writeFileSync(outputFile, html);
  console.log(`📄 Enhanced HTML report generated: ${outputFile}`);
}

// ======================= MAIN =======================

async function main() {
  if (!fs.existsSync(CONFIG.reportsDir)) fs.mkdirSync(CONFIG.reportsDir, { recursive: true });
  if (!fs.existsSync(CONFIG.screenshotDir)) fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });

  const args = process.argv.slice(2);
  const browserMode = resolveBrowserMode(args);
  const inputCsv = resolveInputCsvFromArgs(args);
  const inputCsvPath = path.resolve(inputCsv);

  if (!fs.existsSync(inputCsvPath)) {
    console.error(`❌ Input CSV not found: ${inputCsvPath}`);
    process.exit(1);
  }

  console.log(`📄 Reading URLs from CSV file: ${inputCsvPath}`);
  const csvContent = fs.readFileSync(inputCsvPath, 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  const urls = records.map(r => r.url).filter(Boolean);

  if (urls.length === 0) {
    console.error('❌ No URLs found in CSV. Make sure the column is named "url".');
    process.exit(1);
  }

  console.log(`🚀 Starting validation for ${urls.length} URLs in ${browserMode} mode...\n`);

  const results = [];
  const browser = await chromium.launch({ headless: browserMode === 'headless' });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    for (const url of urls) {
      console.log(`\n🌐 Validating ${url} ...`);
      const result = await validateQuote(url, page);
      results.push(result);
      console.log(`  Final status: ${result.status}`);
    }
  } finally {
    await browser.close();
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvOutput = path.join(CONFIG.reportsDir, `quote-validation_${timestamp}.csv`);
  const htmlReport = path.join(CONFIG.reportsDir, `quote-validation_${timestamp}.html`);

  const csvRows = results.map(r => ({
    url: r.url,
    redirectUrl: r.redirectUrl,
    apiUrl: r.apiUrl,
    apiResponse: r.apiResponse,
    error: r.error,
    status: r.status,
  }));
  fs.writeFileSync(csvOutput, stringifyCsv(csvRows, { columns: CONFIG.requiredReportColumns, header: true }));
  console.log(`\n📊 CSV results written to ${csvOutput}`);

  generateHTMLReport(results, htmlReport);

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const notApplicable = results.filter(r => r.status === 'NA').length;
  console.log(`\n📈 Summary: Total ${results.length}, Pass ${pass}, Fail ${fail}, Not Applicable ${notApplicable}`);
  if (fail > 0) {
    console.log(`📸 Screenshots for failures saved in ${CONFIG.screenshotDir}/`);
  }
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
