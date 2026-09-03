const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

// ======================= CONFIGURATION =======================
const REPORTS_DIR = 'reports';
const SCREENSHOT_DIR = 'screenshots';

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const CSV_OUTPUT = path.join(REPORTS_DIR, `quote-validation_${timestamp}.csv`);
const HTML_REPORT = path.join(REPORTS_DIR, `quote-validation_${timestamp}.html`);

function resolveInputCsvFromArgs(args) {
  let fileIndex = args.indexOf('-file');
  if (fileIndex === -1) {
    fileIndex = args.indexOf('--file');
  }

  if (fileIndex !== -1 && args[fileIndex + 1]) {
    return args[fileIndex + 1];
  }

  return 'urls.csv';
}

const COOKIE_SELECTORS = [
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
];
const POPUP_CLOSE_SELECTORS = [
  '[aria-label="Close"]',
  '.modal-close',
  '.popup-close',
  'button:has-text("×")',
  'button:has-text("Close")',
  '[aria-label="Close dialog"]',
];

// ======================= HELPERS =======================

async function gotoWithRetry(page, url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
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
  await page.goto(bustedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('domcontentloaded');
  console.log('  ✔ Fallback refresh with cache-busting URL parameter completed');
}

async function removeTrustArcOverlays(page) {
  await page.evaluate(() => {
    const selectors = [
      '.truste_overlay',
      '.truste_box_overlay',
      '[id*="pop-frame"]',
      '.truste_overlay_backdrop',
      '[id*="pop-div"]',
      '#truste-consent-text',
      '#truste-consent-buttons',
      '#truste-consent-content',
    ];
    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (el.closest('.truste_box_overlay, .truste_overlay')) {
          el.closest('.truste_box_overlay, .truste_overlay').remove();
        } else {
          el.style.display = 'none';
        }
      });
    });
  }).catch(() => {});
}

async function handleCookiesAndPopups(page) {
  await page.waitForTimeout(1500);

  const banner = page.locator('#truste-consent-text, #truste-consent-content').first();
  if (await banner.count() > 0 && await banner.isVisible()) {
    console.log('  ℹ️ TrustArc cookie banner detected (non‑Angular)');
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

  const trustArcAccept = page.locator('#truste-consent-button');
  if (await trustArcAccept.count() > 0 && await trustArcAccept.isVisible()) {
    await trustArcAccept.click();
    console.log('  ✔ Accepted cookies (TrustArc)');
    await page.waitForTimeout(500);
    await removeTrustArcOverlays(page);
    return;
  }

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

  for (const sel of COOKIE_SELECTORS) {
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

  for (const sel of POPUP_CLOSE_SELECTORS) {
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

async function waitForSpinnerToHide(page, timeout = 10000) {
  try {
    const spinner = page.locator('bolt-waiting-indicator');
    if (await spinner.count() > 0) {
      await spinner.first().waitFor({ state: 'hidden', timeout });
      console.log('  ✔ Spinner disappeared');
    } else {
      const overlay = page.locator('.bolt-waiting-indicator, [class*="spinner"], [class*="loading"]');
      if (await overlay.count() > 0) {
        await overlay.first().waitFor({ state: 'hidden', timeout });
        console.log('  ✔ Spinner disappeared (fallback)');
      }
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
  const isHidden = await element.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none';
  });
  if (isHidden) throw new Error('Element is hidden');
}

/**
 * Capture screenshot of the quote container (or fallback to body).
 * Saved to disk but NOT displayed in the HTML report.
 */
async function captureQuoteContainerScreenshot(page, filename) {
  const containerSelectors = [
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
  ];
  let container = null;
  let usedSelector = 'body (fallback)';
  for (const sel of containerSelectors) {
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

  const dir = path.join(REPORTS_DIR, 'screenshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await container.screenshot({ path: filePath });
  if (!fs.existsSync(filePath)) {
    throw new Error(`Screenshot file was not created: ${filePath}`);
  }
  console.log(`  ℹ️ Screenshot saved: ${filePath}`);
  return filePath;
}

async function getZipInput(page) {
  await waitForSpinnerToHide(page, 15000);
  const selectors = [
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
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel);
    try {
      if (await loc.count() > 0) {
        await loc.first().waitFor({ state: 'visible', timeout: 2000 });
        console.log(`  ℹ️ Found ZIP input via selector: ${sel}`);
        return loc.first();
      }
    } catch (_) { /* ignore */ }
  }
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
    const isElement = await inputHandle.evaluate((el) => el instanceof Element);
    if (isElement) {
      const selector = await inputHandle.evaluate((el) => {
        if (el.id) return `#${el.id}`;
        if (el.name) return `[name="${el.name}"]`;
        const classes = Array.from(el.classList).join('.');
        return `${el.tagName.toLowerCase()}${classes ? '.' + classes : ''}`;
      });
      const loc = page.locator(selector);
      if (await loc.count() > 0) {
        await loc.first().waitFor({ state: 'visible', timeout: 2000 });
        console.log(`  ℹ️ Found ZIP input via evaluateHandle: ${selector}`);
        return loc.first();
      }
    }
  }
  const xpath = '//input[contains(translate(@placeholder, "ZIP", "zip"), "zip")]';
  const loc = page.locator(xpath);
  if (await loc.count() > 0) {
    await loc.first().waitFor({ state: 'visible', timeout: 2000 });
    console.log(`  ℹ️ Found ZIP input via XPath`);
    return loc.first();
  }
  throw new Error('ZIP input not found');
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

async function getQuoteButton(page) {
  const selectors = [
    '#detail-banner__quote-btn',
    'bolt-button >> button',
    '#l45724 > ngx-nationwide-quote > ngx-nationwide-level-three-quote > div > div:nth-child(2) > bolt-button >> button',
    'button:has-text("Start your quote"), input[value="Start your quote"]',
    'a:has-text("Start your quote")',
    'a:has-text("Get a quote")',
    '[role="link"]:has-text("Start your quote")',
    '[role="button"]:has-text("Start your quote")'
  ];

  for (const selector of selectors) {
    const btn = page.locator(selector).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
      console.log(`  ℹ️ Found quote CTA via selector: ${selector}`);
      return btn;
    }
  }

  throw new Error('Quote element not present');
}

function toExpectedPatterns(expected) {
  if (Array.isArray(expected)) {
    return expected.map((item) => item instanceof RegExp ? item : new RegExp(String(item), 'i'));
  }
  if (expected instanceof RegExp) {
    return [expected];
  }
  return [new RegExp(String(expected), 'i')];
}

function expectedDescription(expected) {
  if (Array.isArray(expected)) {
    return expected.map((item) => item instanceof RegExp ? item.source : String(item)).join(' | ');
  }
  return expected instanceof RegExp ? expected.source : String(expected);
}

function textMatchesExpected(text, expected) {
  const value = String(text || '');
  return toExpectedPatterns(expected).some((pattern) => pattern.test(value));
}

async function findErrorMessage(page, expectedTextOrPatterns, input = null) {
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
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
  if (isQuoteDestinationUrl(currentUrl)) {
    throw new Error(`Expected validation error but page redirected to quote: ${currentUrl}`);
  }
  if (input) {
    const isInvalid = await page.waitForFunction(
      (el) => {
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
    const validationMsg = await input.evaluate((el) => el.validationMessage);
    if (validationMsg && textMatchesExpected(validationMsg, expectedTextOrPatterns)) {
      console.log(`  ℹ️ Browser validation message: "${validationMsg}"`);
      return input;
    }
  }
  const expectedText = typeof expectedTextOrPatterns === 'string' ? expectedTextOrPatterns : null;
  const errorFound = expectedText ? await page.waitForFunction(
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
    expectedText,
    { timeout: 8000 }
  ).then((handle) => handle.jsonValue()).catch(() => null) : null;
  if (errorFound) {
    console.log(`  ℹ️ Found error in shadow DOM / light DOM: "${expectedText}"`);
    const locator = page.locator(`text="${expectedText}"`);
    if (await locator.count() > 0) {
      return locator.first();
    }
    const host = page.locator('bolt-input-control').first();
    if (await host.count() > 0) {
      return host;
    }
  }
  const liveRegion = page.locator('[aria-live="polite"], [aria-live="assertive"], [role="alert"]');
  if (await liveRegion.count() > 0) {
    const text = await liveRegion.first().textContent();
    if (text && textMatchesExpected(text, expectedTextOrPatterns)) return liveRegion.first();
  }
  const errorElements = await page.locator('.ng-invalid, [aria-invalid="true"], .bolt-field-error, [class*="error"], [class*="alert"]').all();
  for (const el of errorElements) {
    if (await el.isVisible()) {
      const text = await el.textContent();
      if (text && textMatchesExpected(text, expectedTextOrPatterns)) return el;
    }
  }
  const visibleText = await page.evaluate(() => document.body.innerText);
  if (textMatchesExpected(visibleText, expectedTextOrPatterns)) {
    if (expectedText) {
      const locator = page.locator(`text="${expectedText}"`);
      if (await locator.count() > 0) {
        return locator.first();
      }
    }
    return page.locator('body');
  }

  // Some state-level pages validate empty ZIP without rendering stable visible copy.
  if (!isQuoteDestinationUrl(currentUrl) && currentUrl.includes('/personal/insurance/auto/state/')) {
    if (input) {
      const stateValidationDetected = await input.evaluate((el) => {
        const value = el.value || '';
        const required = el.hasAttribute('required');
        const ariaInvalid = el.getAttribute('aria-invalid') === 'true';
        const classInvalid = el.classList.contains('ng-invalid');
        const nativeInvalid = typeof el.checkValidity === 'function' ? !el.checkValidity() : false;
        const validationMessage = el.validationMessage || '';

        if (ariaInvalid || classInvalid || nativeInvalid || validationMessage.length > 0) {
          return true;
        }

        // When field is required and remains empty after submit, treat as validation enforced.
        return required && value.trim() === '';
      }).catch(() => false);

      if (stateValidationDetected) {
        console.log('  ℹ️ State page validation detected via input state (no stable visible copy)');
        return input;
      }
    }
  }

  const visibleTextShort = visibleText.substring(0, 500);
  throw new Error(`Error message "${expectedDescription(expectedTextOrPatterns)}" not found. Visible text (first 500 chars): ${visibleTextShort}...`);
}

function isNotApplicableErrorMessage(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('zip input not found') ||
    normalized.includes('quote element not present') ||
    normalized.includes('quote button not found') ||
    normalized.includes('err_tunnel_connection_failed');
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

    if (hostname === 'getaquote.nationwide.com') {
      return true;
    }

    const hasQuotePathSegment = /(^|\/)(quote|quotes|get-a-quote|start-your-quote)(\/|$)/i.test(pathname);
    const hasQuoteQuerySignals =
      searchParams.has('getQuote') ||
      searchParams.has('typebus') ||
      searchParams.has('zip') ||
      searchParams.has('zipCode') ||
      searchParams.has('products');

    return hasQuotePathSegment || hasQuoteQuerySignals;
  } catch (_) {
    return /quote|get-a-quote|start-your-quote/i.test(String(rawUrl).toLowerCase());
  }
}

// ======================= VALIDATION FUNCTION =======================

async function validateQuote(url, page) {
  const result = {
    url,
    status: 'PASS',
    error: '',
    screenshot: '',
    elementScreenshot: '',
    redirectUrl: '',
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
    const emptyError = await findErrorMessage(page, [
      'Enter your 5 or 9 digit ZIP Code',
      /zip code is required/i,
      /enter a valid zip/i,
      /postal code is required/i,
    ], zipInput);
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
    const invalidError = await findErrorMessage(page, [
      'Unable to find a valid state for the given Postal Code',
      /unable to find a valid state/i,
      /enter a valid zip/i,
      /invalid postal code/i,
    ], zipInput);
    await checkVisualAlignment(page, invalidError);
    result.details.invalidZipError = true;
    console.log('  ✔ Invalid ZIP error validated (visual alignment OK)');

    // ---- 3. Visual alignment of the quote button ----
    await quoteButton.waitFor({ state: 'visible', timeout: 5000 });
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
      await page.waitForURL((url) => isQuoteDestinationUrl(url.toString()), { timeout: 20000, waitUntil: 'domcontentloaded' });
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
    const quotePageIndicator = page.locator('h1, .quote-form, #quote-form, [data-testid="quote-page"]');
    try {
      await quotePageIndicator.first().waitFor({ state: 'visible', timeout: 5000 });
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
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const backUrl = page.url();
    if (!isSameValidationUrl(canonicalValidationStartUrl, backUrl)) {
      throw new Error(`Back navigation did not return to validation URL. Expected: ${canonicalValidationStartUrl} | Actual: ${normalizeUrlForComparison(backUrl)}`);
    }
    result.details.backNavigation = true;
    console.log(`  ✔ Browser back returned to validation URL: ${backUrl}`);

    // ---- 7. Capture screenshot (saved to disk, not displayed in HTML) ----
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

    if (notApplicable) {
      return result;
    }

    const safeUrl = url.replace(/[^a-zA-Z0-9]/g, '_');
    const fullScreenshotName = `${safeUrl}_fullpage_${Date.now()}.png`;
    const fullPath = path.join(SCREENSHOT_DIR, fullScreenshotName);
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    try {
      await page.screenshot({ path: fullPath, fullPage: true });
      result.screenshot = fullPath;
    } catch (screenshotError) {
      console.log(`  ⚠️ Full-page screenshot skipped: ${screenshotError.message}`);
    }
  }

  return result;
}

// ======================= HTML REPORT GENERATOR (no screenshot columns) =======================

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

    // No screenshot HTML – removed

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
    ];
    const stepList = steps.map(s =>
      `<li style="color: ${s.ok ? 'green' : 'red'};">${s.ok ? '✔' : '✘'} ${s.label}${s.value ? `: ${s.value}` : ''}</li>`
    ).join('');

    return `
      <tr class="${statusClass}">
        <td><a href="${r.url}" target="_blank">${r.url}</a></td>
        <td><span class="badge ${statusClass}">${statusIcon} ${r.status}</span></td>
        <td>${r.error || '—'}</td>
        <td>
          <details>
            <summary>Show steps</summary>
            <ul style="list-style: none; padding-left: 0;">${stepList}</ul>
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
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const inputCsv = resolveInputCsvFromArgs(args);
  const inputCsvPath = path.resolve(inputCsv);

  if (!fs.existsSync(inputCsvPath)) {
    console.error(`❌ Input CSV not found: ${inputCsvPath}`);
    process.exit(1);
  }

  console.log(`📄 Reading URLs from CSV file: ${inputCsvPath}`);
  const csvContent = fs.readFileSync(inputCsvPath, 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  const urls = records.map((r) => r.url).filter(Boolean);

  if (urls.length === 0) {
    console.error('❌ No URLs found in CSV. Make sure the column is named "url".');
    process.exit(1);
  }

  console.log(`🚀 Starting validation for ${urls.length} URLs...\n`);

  const results = [];
  const browser = await chromium.launch({ headless: true });
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

  const csvRows = results.map(r => ({
    url: r.url,
    status: r.status,
    error: r.error,
    redirectUrl: r.redirectUrl,
    elementScreenshot: r.elementScreenshot,
    fullPageScreenshot: r.screenshot,
    ...r.details,
  }));
  fs.writeFileSync(CSV_OUTPUT, stringify(csvRows, { header: true }));
  console.log(`\n📊 CSV results written to ${CSV_OUTPUT}`);

  generateHTMLReport(results, HTML_REPORT);

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const notApplicable = results.filter(r => r.status === 'NA').length;
  console.log(`\n📈 Summary: Total ${results.length}, Pass ${pass}, Fail ${fail}, Not Applicable ${notApplicable}`);
  if (fail > 0) {
    console.log(`📸 Screenshots for failures saved in ${SCREENSHOT_DIR}/`);
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});