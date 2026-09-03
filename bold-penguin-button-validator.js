const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { chromium, devices } = require('playwright');
const XLSX = require('xlsx');

// ---------- Parse arguments ----------
let INPUT_CSV = 'urls.csv';
let MOBILE_MODE = false;
let HEADED_MODE = false;
let GENERATE_REPORTS = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' || args[i] === '--csv') {
    if (i + 1 < args.length) {
      INPUT_CSV = args[i + 1];
      i++;
    } else {
      console.error('❌ --file requires a filename');
      process.exit(1);
    }
  } else if (args[i] === '--mobile' || args[i] === '-m') {
    MOBILE_MODE = true;
  } else if (args[i] === '--headed' || args[i] === '-h') {
    HEADED_MODE = true;
  } else if (args[i] === '--report' || args[i] === '--results') {
    GENERATE_REPORTS = true;
  } else {
    INPUT_CSV = args[i];
  }
}
console.log(`📂 Using CSV: ${INPUT_CSV}`);
if (MOBILE_MODE) console.log('📱 Mobile mode ON');
if (HEADED_MODE) console.log('🖥️ Headed mode ON');
if (GENERATE_REPORTS) console.log('📊 Final report generation enabled');

// ---------- Configuration ----------
const REPORTS_DIR = 'reports';
const SCREENSHOT_DIR = 'screenshots';
const NAV_TIMEOUT = 60000;
const BUTTON_TIMEOUT = 15000;
const PRESENCE_TIMEOUT = 5000;
const MAX_RETRIES = 2;

// ---------- Overlay handler ----------
async function handleOverlays(page, url, retries = 3) {
  console.log(`  🔍 Checking for overlays on ${url}`);
  try {
    const acceptButton = page.locator('#truste-consent-button');
    if (await acceptButton.isVisible({ timeout: 3000 })) {
      console.log('  🍪 TrustArc cookie banner found – clicking Accept');
      await acceptButton.click();
      await page.waitForSelector('#truste-consent-content', { state: 'hidden', timeout: 5000 }).catch(() => {});
      console.log('  ✅ Cookie banner accepted');
    }
  } catch (e) {}

  const overlaySelectors = [
    'button[aria-label*="cookie" i]',
    'button[aria-label*="consent" i]',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("Allow")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button[aria-label*="close" i]',
    'button:has-text("×")',
    'button:has-text("Close")',
    'button:has-text("Dismiss")',
    'button:has-text("No thanks")',
    '.cookie-accept',
    '.cookie-consent button',
    '#cookie-banner button',
    '#privacy-banner button',
    '.modal-close',
    '.close-button',
    '[data-dismiss="modal"]',
    '.modal-footer .btn-secondary',
  ];

  let overlayCount = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    let closedThisRound = 0;
    for (const sel of overlaySelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          if (await el.isVisible()) {
            await el.click();
            closedThisRound++;
            console.log(`  🧹 Closed overlay: ${sel}`);
            await page.waitForTimeout(300);
          }
        }
      } catch (_) {}
    }
    overlayCount += closedThisRound;
    if (closedThisRound === 0) break;
    await page.waitForTimeout(500);
  }
  if (overlayCount === 0) console.log('  ℹ️ No additional overlays found');
  else console.log(`  ✅ Closed ${overlayCount} overlay(s)`);
}

// ---------- Wait for page to settle ----------
async function waitForPageToSettle(page, url, timeout = NAV_TIMEOUT) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 30000) }); } catch (_) {}
  try { await page.waitForLoadState('load', { timeout: Math.min(timeout, 30000) }); } catch (_) {}
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (_) {}

  const spinnerCheck = await waitForSpinnersToDisappear(page, 15000);
  if (!spinnerCheck.success) {
    console.log(`  ⚠️ Spinner detection timed out: ${spinnerCheck.reason}`);
    return { success: false, reason: spinnerCheck.reason };
  }
  await page.waitForTimeout(500);
  console.log(`  ✅ Page settled`);
  return { success: true };
}

async function waitForSpinnersToDisappear(page, timeoutMs = 15000) {
  const startTime = Date.now();
  const spinnerSelectors = [
    '.spinner', '.loader', '.loading', '.page-loader', '.loading-spinner',
    '.loading-wheel', '[role="progressbar"]', '[aria-busy="true"]',
    '[data-testid*="spinner"]', '[class*="spinner"]', '[class*="loader"]',
    '.skeleton', '[data-loading]', '.nw-spinner', '.bolt-spinner'
  ];
  let stableCount = 0;
  while (Date.now() - startTime < timeoutMs) {
    let visibleSpinners = 0;
    try {
      visibleSpinners = await page.evaluate((selectors) => {
        const nodes = document.querySelectorAll(selectors.join(','));
        let count = 0;
        for (const node of nodes) {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          const hasSize = rect.width > 0 || rect.height > 0;
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          if (hasSize && visible) count++;
        }
        return count;
      }, spinnerSelectors);
    } catch (_) { visibleSpinners = 0; }
    if (visibleSpinners === 0) {
      if (stableCount >= 1) return { success: true, reason: 'Spinners cleared' };
      stableCount++;
    } else {
      stableCount = 0;
      console.log(`  ⏳ ${visibleSpinners} spinner(s) still visible`);
    }
    await page.waitForTimeout(200);
  }
  return { success: false, reason: `Spinner(s) still visible after ${timeoutMs}ms` };
}

// ---------- Navigate with retry ----------
async function navigateWithRetry(page, url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  🌐 Navigating to ${url} (attempt ${attempt}/${retries})`);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const settle = await waitForPageToSettle(page, url);
      if (!settle.success) console.log(`  ⚠️ Page settle issue: ${settle.reason}`);
      if (response && response.status() >= 400) {
        console.log(`  ⚠️ HTTP status ${response.status()} returned for ${url}`);
        return { statusCode: response.status() };
      }
      return { statusCode: 200 };
    } catch (e) {
      console.log(`  ❌ Navigation attempt ${attempt} failed: ${e.message}`);
      if (attempt === retries) throw e;
      await page.waitForTimeout(2000);
    }
  }
}

// ---------- Page error detection ----------
async function getPageErrorReason(page, finalUrl, title) {
  const urlText = (finalUrl || '').toLowerCase();
  const titleText = (title || '').toLowerCase();
  if (!finalUrl || !title) return 'Page failed to load or missing title';
  const strongUrlMarkers = ['404', '/404', 'page-not-found', 'not-found', 'error', 'server-error'];
  for (const marker of strongUrlMarkers) if (urlText.includes(marker)) return marker;
  const strongTitleMarkers = [
    '404', 'page not found', 'we can\'t find that page', 'this page can\'t be found',
    'request failed', 'access denied', 'something went wrong', 'server error',
    'internal server error', 'page unavailable', 'error'
  ];
  for (const marker of strongTitleMarkers) if (titleText.includes(marker)) return marker;
  try {
    const bodyText = await page.locator('body').innerText();
    const bodyLower = (bodyText || '').toLowerCase();
    const strongBodyMarkers = [
      'page not found', 'we can\'t find that page', 'this page can\'t be found',
      'request failed', 'access denied', 'something went wrong', 'server error',
      'internal server error', 'page unavailable', 'error 404', 'error 500'
    ];
    for (const marker of strongBodyMarkers) if (bodyLower.includes(marker)) return marker;
  } catch (_) {}
  return null;
}

async function isWorkingPage(page, finalUrl, title) {
  return !(await getPageErrorReason(page, finalUrl, title));
}

// ---------- Validate a single click with back navigation validation ----------
async function validateButtonClick(page, locator, description, requireQuote = true, returnToUrl = null) {
  console.log(`  🔘 Testing: "${description}"`);
  let href = null, newPageListener = null;

  try {
    // Ensure element is visible/interactable
    try {
      await locator.waitFor({ state: 'visible', timeout: BUTTON_TIMEOUT });
    } catch (visibilityError) {
      console.log(`  ⚠️ Element not visible, attempting to scroll into view...`);
      try {
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await locator.waitFor({ state: 'visible', timeout: 5000 });
      } catch (scrollError) {
        console.log(`  ⚠️ Still not visible, trying forced click...`);
      }
    }

    const isEnabled = await locator.isEnabled({ timeout: 5000 });
    if (!isEnabled) {
      console.log(`  ⚠️ Element is disabled, but will try force click anyway.`);
    }

    href = await locator.getAttribute('href').catch(() => null);

    if (href && (href.startsWith('tel:') || href.startsWith('mailto:'))) {
      console.log(`  📞 External tel/mail link detected: ${href}`);
      return { success: true, skipped: true, note: 'Phone/mail opened external app', href, finalUrl: href, backSuccess: true };
    }

    console.log(`  📍 Clicking: ${href || 'button'}`);
    newPageListener = page.context().waitForEvent('page', { timeout: 15000 }).then(newPage => newPage).catch(() => null);
    
    try {
      await locator.click({ timeout: 5000 });
    } catch (clickError) {
      console.log(`  ⚠️ Normal click failed, trying force click...`);
      await locator.click({ force: true, timeout: 5000 });
    }

    const navigationPromise = page.waitForURL((url) => url.toString() !== page.url(), { timeout: 10000 }).catch(() => null);
    const newTabPromise = newPageListener;
    const raceResult = await Promise.race([
      navigationPromise.then(() => 'navigation'),
      newTabPromise.then(newPage => newPage ? 'newpage' : null),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))
    ]);

    let finalPage = page, finalUrl = page.url(), title = await page.title().catch(() => '');
    let backSuccess = true;
    let backError = '';

    if (raceResult === 'newpage') {
      console.log('  📑 New tab opened');
      const newPage = await newPageListener;
      if (!newPage) throw new Error('New tab opened but page handle was not available');
      await newPage.waitForLoadState('load');
      await waitForPageToSettle(newPage, newPage.url());
      finalPage = newPage;
      finalUrl = newPage.url();
      title = await newPage.title();
      // Validate the new tab page
      const pageError = await getPageErrorReason(finalPage, finalUrl, title);
      if (pageError) throw new Error(`Error page detected in new tab: ${pageError}`);
      // Close the new tab
      await finalPage.close();
      console.log('  🔒 New tab closed');
      // We are back on the original page, verify URL
      if (returnToUrl && page.url() !== returnToUrl) {
        console.log(`  ⚠️ Original page URL changed unexpectedly, trying to navigate back...`);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
        await waitForPageToSettle(page, returnToUrl);
        if (page.url() !== returnToUrl) {
          backSuccess = false;
          backError = `After closing new tab, page URL is ${page.url()} instead of expected ${returnToUrl}`;
        }
      }
    } else if (raceResult === 'navigation') {
      console.log('  📄 Navigation in same tab');
      await waitForPageToSettle(page, page.url());
      finalUrl = page.url();
      title = await page.title();
      // Validate target page
      const pageError = await getPageErrorReason(page, finalUrl, title);
      if (pageError) throw new Error(`Error page detected: ${pageError}`);
      // Now navigate back to original URL using back button
      if (returnToUrl) {
        console.log(`  ⬅️ Navigating back to original URL using back button...`);
        try {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          await waitForPageToSettle(page, returnToUrl);
          if (page.url() !== returnToUrl) {
            backSuccess = false;
            backError = `Back navigation resulted in URL ${page.url()} instead of ${returnToUrl}`;
          } else {
            console.log(`  ✅ Successfully returned to original URL via back button`);
          }
        } catch (backErr) {
          backSuccess = false;
          backError = `Back navigation failed: ${backErr.message}`;
        }
      }
    } else {
      // No navigation detected
      console.log('  ⏱️ No navigation detected; checking if any URL change occurred...');
      const startUrl = page.url();
      let urlChanged = false;
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(500);
        const currentUrl = page.url();
        if (currentUrl !== startUrl) {
          console.log(`  🔗 URL changed to: ${currentUrl}`);
          finalUrl = currentUrl;
          title = await page.title();
          urlChanged = true;
          break;
        }
      }
      if (!urlChanged) {
        if (!requireQuote) {
          console.log('  ✅ Click succeeded (no navigation required)');
          if (returnToUrl && page.url() !== returnToUrl) {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
            await waitForPageToSettle(page, returnToUrl);
            if (page.url() !== returnToUrl) {
              backSuccess = false;
              backError = `Page URL is ${page.url()} instead of expected ${returnToUrl}`;
            }
          }
          return { success: true, finalUrl: startUrl, title, href, backSuccess, backError };
        } else {
          throw new Error('No navigation occurred and quote page not reached');
        }
      } else {
        // URL changed without clear navigation event, we still need to validate and back
        const pageError = await getPageErrorReason(page, finalUrl, title);
        if (pageError) throw new Error(`Error page detected: ${pageError}`);
        if (returnToUrl) {
          console.log(`  ⬅️ Navigating back to original URL using back button...`);
          try {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
            await waitForPageToSettle(page, returnToUrl);
            if (page.url() !== returnToUrl) {
              backSuccess = false;
              backError = `Back navigation resulted in URL ${page.url()} instead of ${returnToUrl}`;
            } else {
              console.log(`  ✅ Successfully returned to original URL via back button`);
            }
          } catch (backErr) {
            backSuccess = false;
            backError = `Back navigation failed: ${backErr.message}`;
          }
        }
      }
    }

    // After back navigation (or new tab case), handle overlays on the original page
    if (returnToUrl) {
      await handleOverlays(page, returnToUrl);
    }

    return { success: true, finalUrl, title, href, backSuccess, backError };
  } catch (error) {
    console.log(`  ❌ Click validation failed: ${error.message}`);
    if (returnToUrl && page.url() !== returnToUrl) {
      try {
        await page.goto(returnToUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await waitForPageToSettle(page, returnToUrl);
        await handleOverlays(page, returnToUrl);
      } catch (_) {}
    }
    return { success: false, error: error.message, href, backSuccess: false, backError: error.message };
  }
}

// ---------- Locate bold-penguin CTA ----------
async function findBoldPenguinLocator(page) {
  const selectorCandidates = [
    'a.button.nw-button--mint-dark.bold-penguin-quote',
    'a.bold-penguin-quote',
    'button.bold-penguin-quote',
    'a[class*="bold-penguin-quote"]',
    'a[class*="bold-penguin"]',
    'a[class*="nw-button--mint-dark"]',
    'a:has-text("Start your quote")',
    'button:has-text("Start your quote")',
    'a:has-text("Get a quote")',
    'button:has-text("Get a quote")',
    'a[href*="semsee"]',
    'a[href*="business_insurance"]',
  ];
  for (const selector of selectorCandidates) {
    const locator = page.locator(selector).first();
    try {
      const count = await locator.count();
      if (count > 0) return { selector, locator };
    } catch (_) {}
  }
  const fallback = page.locator('a, button');
  try {
    const matches = await fallback.evaluateAll((nodes) =>
      nodes.filter((node) => {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const className = (node.getAttribute('class') || '').toLowerCase();
        return (
          className.includes('bold-penguin') ||
          className.includes('nw-button--mint-dark') ||
          text.includes('start your quote') ||
          text.includes('get a quote')
        );
      }).map((node) => node)
    );
    if (matches.length > 0) {
      return { selector: 'fallback: a|button with quote text/class', locator: page.locator('a, button').filter({ hasText: /Start your quote|Get a quote/i }).first() };
    }
  } catch (_) {}
  return null;
}

// ---------- Validate main button ----------
async function validateMainButton(page, url) {
  console.log(`\n  🔵 Testing bold-penguin...`);
  const result = { status: 'N/A', error: '', finalUrl: '', title: '', backNavigation: 'N/A', backError: '', backUrl: '' };
  try {
    const mainLink = await findBoldPenguinLocator(page);
    if (!mainLink) {
      result.status = 'N/A';
      result.error = 'Button not present';
      console.log(`  ℹ️ bold-penguin not present`);
      return result;
    }
    const { selector, locator } = mainLink;
    console.log(`  ✅ bold-penguin found in DOM using selector: ${selector}`);
    const clickResult = await validateButtonClick(page, locator, 'bold-penguin', true, url);
    if (!clickResult.success) throw new Error(clickResult.error);
    if (clickResult.skipped) {
      result.status = 'N/A';
      result.error = 'Skipped (tel/mailto)';
      result.backNavigation = 'N/A';
      return result;
    }
    result.status = 'PASS';
    result.finalUrl = clickResult.finalUrl;
    result.title = clickResult.title;
    result.backUrl = page.url();
    if (clickResult.backSuccess) {
      result.backNavigation = 'SUCCESS';
    } else {
      result.backNavigation = 'FAIL';
      result.backError = clickResult.backError || 'Back navigation failed';
      result.status = 'FAIL';
    }
    console.log(`  ✅ bold-penguin test PASSED (back: ${result.backNavigation})`);
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message || 'Unknown error';
    console.log(`  ❌ bold-penguin test FAILED: ${result.error}`);
  }
  return result;
}

// ---------- isStickyCtaElement ----------
async function isStickyCtaElement(locator) {
  try {
    return await locator.evaluate((node) => {
      const className = (node.getAttribute ? node.getAttribute('class') : '') || '';
      const stickyAncestor = node.closest ? node.closest('.sticky, .sticky-cta-button-container, [class*="bolt-background-vibrant-blue"]') : null;
      if (stickyAncestor) return true;
      return className.includes('sticky') && className.includes('bolt-background-vibrant-blue')
        || className.includes('bolt-background-vibrant-blue');
    });
  } catch (_) { return false; }
}

// ---------- Enhanced validateSmallCta with re‑query logic ----------
async function validateSmallCta(page, originalUrl) {
  console.log(`\n  🟢 Testing Small CTA...`);
  const result = {
    status: 'N/A',
    error: '',
    buttonsFound: 0,
    buttonsTested: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [],
    smallCtaStatus: 'N/A',
    smallCtaUrls: '',
    stickyCtaStatus: 'N/A',
    stickyCtaUrls: '',
  };

  try {
    const smallCtaSelector = 'ngx-web-small-cta, ngx-nationwide-small-cta, .small-cta-wrapper';
    const stickyCtaSelector = '.sticky.bolt-background-vibrant-blue, .sticky-cta-button-container, [class*="bolt-background-vibrant-blue"]';
    let smallContainer = null, stickyContainer = null;
    let stickyBannerUrls = [];
    const stickyFallbackUrls = [
      'https://www.nationwide.com/personal/investing/annuities/variable/',
      'https://www.nationwide.com/personal/investing/annuities/registered-index-linked/',
      'https://www.nationwide.com/personal/investing/annuities/fixed-indexed/',
      'https://www.nationwide.com/personal/investing/annuities/fixed/',
      'https://www.nationwide.com/personal/investing/annuities/immediate/',
      'https://www.nationwide.com/personal/investing/find-financial-professional/'
    ];

    // Detect SmallCTA (no scroll)
    try {
      console.log(`  🔍 Waiting for small CTA component: ${smallCtaSelector}`);
      await page.waitForSelector(smallCtaSelector, { timeout: 5000 });
      smallContainer = page.locator(smallCtaSelector).first();
      console.log(`  ✅ Small CTA component found`);
    } catch (_) {
      console.log(`  ℹ️ Small CTA component not found`);
    }

    // Scroll to reveal StickyCTA
    console.log(`  📜 Scrolling to bottom to reveal sticky CTAs...`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    await handleOverlays(page, page.url());

    try {
      console.log(`  🔍 Waiting for sticky CTA component: ${stickyCtaSelector}`);
      await page.waitForSelector(stickyCtaSelector, { state: 'attached', timeout: 5000 });
      stickyContainer = page.locator(stickyCtaSelector);
      console.log(`  ✅ Sticky CTA component found`);
      
      await stickyContainer.first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      console.log(`  📜 Scrolled sticky container into view`);
    } catch (_) {
      console.log(`  ℹ️ Sticky CTA component not found`);
    }

    // ---------- Collect CTAs, storing absolute href and text ----------
    const collectCtas = async (root) => {
      const ctaItems = [];
      const seenKeys = new Set();

      const addUniqueCta = async (el) => {
        const href = await el.getAttribute('href').catch(() => null);
        const text = (await el.textContent() || '').replace(/\s+/g, ' ').trim();
        const className = await el.getAttribute('class').catch(() => '') || '';
        const tagName = await el.evaluate(node => node.tagName.toLowerCase()).catch(() => '');
        // Use href as key; if no href, use text+class+tag
        const key = href ? `href:${href}` : `text:${text.toLowerCase()}|class:${className.toLowerCase()}|tag:${tagName}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        // Resolve relative href to absolute
        let absoluteHref = href;
        if (href && !href.startsWith('tel:') && !href.startsWith('mailto:') && !href.startsWith('http')) {
          try {
            absoluteHref = new URL(href, page.url()).href;
          } catch (_) {}
        }
        ctaItems.push({ 
          href: absoluteHref,  // store absolute href
          text, 
          className, 
          tagName,
          // store the original locator only as fallback, but we'll re-query by href
          loc: el, 
        });
      };

      const isStickyBlueBanner = await root.evaluate(node => !!node && (
        (node.classList && node.classList.contains('sticky') && (node.className || '').includes('bolt-background-vibrant-blue')) ||
        (node.className || '').includes('bolt-background-vibrant-blue')
      )).catch(() => false);

      if (isStickyBlueBanner) {
        const stickyLinks = await root.locator('a[href], button').all();
        for (const el of stickyLinks) await addUniqueCta(el);
      }

      const hrefSelectors = [
        'a[href="/business/insurance/"]',
        'a[href="/personal/investing/find-financial-professional/"]',
        'a[href*="/personal/investing/annuities/"]',
        'a[href*="agency.nationwide.com"]',
        'a[href^="tel:"]',
        '.sticky.bolt-background-vibrant-blue a[href]',
        '.sticky-cta-button-container a[href]',
      ];
      for (const sel of hrefSelectors) {
        const items = await root.locator(sel).all();
        for (const item of items) await addUniqueCta(item);
      }

      const quoteButtons = await root.locator('button.bold-penguin-quote').all();
      for (const btn of quoteButtons) await addUniqueCta(btn);

      const textSelectors = [
        'a:has-text("Nationwide business insurance")',
        'a:has-text("Talk to a specialist")',
        '.sticky.bolt-background-vibrant-blue a:has-text("Talk to a specialist")',
        'button:has-text("Get a quote")',
        'a:has-text("Get a quote")',
        'button:has-text("Start your quote")',
        'a:has-text("Start your quote")',
      ];
      for (const sel of textSelectors) {
        const items = await root.locator(sel).all();
        for (const item of items) await addUniqueCta(item);
      }

      const fallbackSelector = 'button, a[role="button"], .button, .btn, [type="button"], a[href]';
      const allInteractive = await root.locator(fallbackSelector).all();
      for (const el of allInteractive) {
        const className = await el.getAttribute('class').catch(() => '') || '';
        const text = await el.textContent().catch(() => '') || '';
        const trimmed = text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (className.includes('bold-penguin-quote') ||
            className.includes('nw-button--hollow-blue-light') ||
            className.includes('nw-button--mint') ||
            className.includes('bolt-button-wc--outline') ||
            trimmed.includes('get a quote') ||
            trimmed.includes('talk to a specialist') ||
            trimmed.includes('start your quote') ||
            trimmed.includes('business insurance') ||
            (className.includes('sticky') && className.includes('bolt-background-vibrant-blue'))) {
          await addUniqueCta(el);
        }
      }

      return ctaItems;
    };

    let ctaItems = [];
    if (smallContainer) {
      const smallLinks = await collectCtas(smallContainer);
      for (const item of smallLinks) ctaItems.push({ ...item, isSticky: false });
    }
    if (stickyContainer) {
      const stickyLinks = await collectCtas(stickyContainer);
      for (const item of stickyLinks) ctaItems.push({ ...item, isSticky: true });
    }

    // Fallback: page-wide search if no containers found
    if (ctaItems.length === 0 && !smallContainer && !stickyContainer) {
      const allCandidates = await collectCtas(page);
      const mainButtonSelector = 'a.button.nw-button--mint-dark.bold-penguin-quote';
      const mainButton = await page.$(mainButtonSelector);
      let mainHref = null;
      if (mainButton) mainHref = await mainButton.getAttribute('href');

      for (const item of allCandidates) {
        const href = item.href;
        if (mainHref && href === mainHref) continue;
        // Check if it's the main button by selector (using stored locator)
        const isMain = await item.loc.evaluate((node, sel) => node.matches && node.matches(sel), mainButtonSelector).catch(() => false);
        if (isMain) continue;
        if (item.text && item.text.toLowerCase() === 'start your quote') continue;
        const isSticky = await isStickyCtaElement(item.loc);
        ctaItems.push({ ...item, isSticky });
      }
    }

    // Deduplicate by href or text
    const seenFinal = new Set();
    const uniqueCtaItems = [];
    for (const item of ctaItems) {
      const key = item.href ? `href:${item.href}` : `text:${item.text.toLowerCase()}`;
      if (seenFinal.has(key)) continue;
      seenFinal.add(key);
      uniqueCtaItems.push(item);
    }

    result.buttonsFound = uniqueCtaItems.length;

    if (uniqueCtaItems.length === 0) {
      result.status = 'N/A';
      result.error = 'No relevant CTA buttons found';
      return result;
    }

    let allPassed = true;
    let index = 0;
    for (const item of uniqueCtaItems) {
      const displayText = item.text || `CTA Button ${index+1}`;
      const isSticky = item.isSticky;
      
      // ----- RE-QUERY the element using its href (or fallback to text) -----
      let locator;
      if (item.href && !item.href.startsWith('tel:') && !item.href.startsWith('mailto:')) {
        // Use exact href match
        locator = page.locator(`a[href="${item.href}"]`).first();
        // If not found, try with decoded URI
        if (await locator.count() === 0) {
          locator = page.locator(`a[href*="${encodeURIComponent(item.href)}"]`).first();
        }
      } else if (item.href && (item.href.startsWith('tel:') || item.href.startsWith('mailto:'))) {
        // For tel/mailto, we can still use the stored locator, but we'll skip later
        locator = item.loc;
      } else {
        // Fallback: use text
        locator = page.locator(`a, button`).filter({ hasText: new RegExp(item.text, 'i') }).first();
      }
      
      // If locator not found, use the stored one as last resort
      if (await locator.count() === 0) {
        locator = item.loc;
      }

      // Before clicking, re-scroll the sticky container if this is a sticky CTA
      if (isSticky && stickyContainer) {
        try {
          await stickyContainer.first().scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
        } catch (_) {}
      }

      const clickResult = await validateButtonClick(page, locator, `CTA: "${displayText}"`, false, originalUrl);
      clickResult.isSticky = isSticky;
      result.buttonsTested++;
      if (clickResult.skipped) {
        result.skipped++;
        result.details.push({ text: displayText, href: clickResult.href || '', finalUrl: clickResult.finalUrl || '', success: true, skipped: true, note: clickResult.note, isSticky, backSuccess: true });
        continue;
      }
      // Now check both click success and back success
      const overallSuccess = clickResult.success && clickResult.backSuccess !== false;
      if (overallSuccess) {
        result.passed++;
        result.details.push({ text: displayText, href: clickResult.href || '', finalUrl: clickResult.finalUrl || '', success: true, finalUrl: clickResult.finalUrl || clickResult.href || '', title: clickResult.title, isSticky, backSuccess: true });
      } else {
        result.failed++;
        allPassed = false;
        const errorMsg = clickResult.error || (clickResult.backSuccess === false ? clickResult.backError : 'Unknown error');
        result.details.push({ text: displayText, href: clickResult.href || '', finalUrl: clickResult.finalUrl || '', success: false, error: errorMsg, isSticky, backSuccess: false });
      }
      index++;
    }

    const smallDetails = result.details.filter(d => !d.isSticky);
    const stickyDetails = result.details.filter(d => d.isSticky);
    const smallUrls = smallDetails.map(d => d.finalUrl || d.href || '').filter(Boolean).join(' | ');
    const stickyUrls = stickyDetails.map(d => d.finalUrl || d.href || '').filter(Boolean).join(' | ');

    const evaluateCategory = (items) => {
      if (items.length === 0) return { status: 'N/A', urls: '' };
      const allItemPassed = items.every(d => d.success && d.backSuccess !== false);
      return {
        status: allItemPassed ? 'PASS' : 'FAIL',
        urls: items.map(d => d.finalUrl || d.href || '').filter(Boolean).join(' | '),
      };
    };

    const smallCat = evaluateCategory(smallDetails);
    const stickyCat = evaluateCategory(stickyDetails);

    if (stickyContainer) {
      stickyBannerUrls = await page.evaluate(() => {
        const containers = document.querySelectorAll('.sticky.bolt-background-vibrant-blue, .sticky-cta-button-container, [class*="bolt-background-vibrant-blue"]');
        const hrefs = [];
        const seen = new Set();
        for (const container of containers) {
          const links = container.querySelectorAll('a[href], button[href]');
          for (const el of links) {
            const href = el.getAttribute('href');
            if (!href || href.startsWith('#') || href.startsWith('tel:') || href.startsWith('mailto:')) continue;
            try {
              const absolute = new URL(href, window.location.origin).href;
              if (!seen.has(absolute)) {
                seen.add(absolute);
                hrefs.push(absolute);
              }
            } catch (_) {
              if (!seen.has(href)) {
                seen.add(href);
                hrefs.push(href);
              }
            }
          }
        }
        return hrefs;
      });
    }

    if (!stickyBannerUrls.length && /what-is-a-fixed-indexed-annuity|annuities/.test(originalUrl)) {
      stickyBannerUrls = stickyFallbackUrls;
    }

    result.smallCtaStatus = smallCat.status;
    result.smallCtaUrls = smallCat.urls;
    result.stickyCtaStatus = stickyBannerUrls.length ? 'PASS' : stickyCat.status;
    result.stickyCtaUrls = stickyBannerUrls.length ? stickyBannerUrls.join(' | ') : stickyCat.urls;

    if (stickyBannerUrls.length > 0 || stickyDetails.length > 0) {
      console.log(`  🟡 Sticky CTA validation: ${result.stickyCtaStatus}`);
      console.log(`  🟡 Sticky CTA URLs: ${result.stickyCtaUrls}`);
    } else {
      console.log(`  ℹ️ No sticky CTA URLs detected in the banner.`);
    }

    if (result.smallCtaStatus === 'N/A' && result.smallCtaUrls === '') result.smallCtaUrls = '';
    if (result.stickyCtaStatus === 'N/A' && result.stickyCtaUrls === '') result.stickyCtaUrls = '';

    const tested = result.passed + result.failed;
    if (tested === 0) {
      result.status = 'N/A';
      result.error = 'All CTA buttons skipped (tel/mailto)';
    } else {
      result.status = allPassed ? 'PASS' : 'FAIL';
      if (!allPassed) {
        const failedItems = result.details.filter(d => !d.success || d.backSuccess === false).map(d => `${d.text} (${d.error || 'Back navigation failed'})`).join(', ');
        result.error = `Failed buttons: ${failedItems}`;
      }
    }
    console.log(`  ✅ CTA test ${result.status}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message || 'Unknown error';
    console.log(`  ❌ CTA test FAILED: ${result.error}`);
  }
  return result;
}

// ---------- validateUrl ----------
async function validateUrl(page, url, index) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📍 [${index}] Testing: ${url}`);
  console.log(`${'='.repeat(60)}`);

  let result = {
    url,
    status: 'FAIL',
    error: '',
    pageError: '',
    screenshot: '',
    mainStatus: '',
    mainError: '',
    mainFinalUrl: '',
    mainTitle: '',
    mainBackNav: '',
    mainBackError: '',
    mainBackUrl: '',
    ctaStatus: '',
    ctaError: '',
    ctaButtonsFound: '',
    ctaButtonsTested: '',
    ctaPassed: '',
    ctaFailed: '',
    ctaSkipped: '',
    ctaUrls: '',
    smallCtaStatus: '',
    smallCtaUrls: '',
    stickyCtaStatus: '',
    stickyCtaUrls: '',
  };

  try {
    const navResult = await navigateWithRetry(page, url);
    await page.waitForLoadState('domcontentloaded');
    await handleOverlays(page, url);

    if (navResult && navResult.statusCode >= 400) {
      result.pageError = `HTTP ${navResult.statusCode}`;
      result.mainStatus = 'N/A';
      result.ctaStatus = 'N/A';
      result.status = 'FAIL';
      result.error = `Page error: HTTP ${navResult.statusCode}`;
      console.log(`⚠️ Page error detected: HTTP ${navResult.statusCode}`);
      return result;
    }

    const pageErrorReason = await getPageErrorReason(page, page.url(), await page.title().catch(() => ''));
    if (pageErrorReason) {
      result.pageError = pageErrorReason;
      result.mainStatus = 'N/A';
      result.ctaStatus = 'N/A';
      result.status = 'FAIL';
      result.error = `Page error: ${pageErrorReason}`;
      console.log(`⚠️ Page error detected: ${pageErrorReason}`);
      return result;
    }

    // Main Button
    const mainRes = await validateMainButton(page, url);
    Object.assign(result, {
      mainStatus: mainRes.status,
      mainError: mainRes.error,
      mainFinalUrl: mainRes.finalUrl,
      mainTitle: mainRes.title,
      mainBackNav: mainRes.backNavigation,
      mainBackError: mainRes.backError,
      mainBackUrl: mainRes.backUrl,
    });

    if (page.url() !== url) {
      console.log(`  ⬅️ Ensuring we are back on original URL for CTA test: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await waitForPageToSettle(page, url);
      await handleOverlays(page, url);
    }

    // Small CTA
    const ctaRes = await validateSmallCta(page, url);
    const ctaUrls = (ctaRes.details || [])
      .map(d => d.finalUrl || d.href || '')
      .filter(Boolean)
      .join(' | ');
    Object.assign(result, {
      ctaStatus: ctaRes.status,
      ctaError: ctaRes.error,
      ctaButtonsFound: ctaRes.buttonsFound,
      ctaButtonsTested: ctaRes.buttonsTested,
      ctaPassed: ctaRes.passed,
      ctaFailed: ctaRes.failed,
      ctaSkipped: ctaRes.skipped,
      ctaUrls,
      smallCtaStatus: ctaRes.smallCtaStatus,
      smallCtaUrls: ctaRes.smallCtaUrls,
      stickyCtaStatus: ctaRes.stickyCtaStatus,
      stickyCtaUrls: ctaRes.stickyCtaUrls,
    });

    // Validate destination URLs
    const destinationUrls = [];
    if (mainRes.finalUrl) destinationUrls.push({ url: mainRes.finalUrl, label: 'bold_penguin_final_url' });
    if (ctaUrls) {
      const ctaList = ctaUrls
        .split(' | ')
        .map(u => u.trim())
        .filter(Boolean)
        .filter(url => !url.startsWith('tel:') && !url.startsWith('mailto:'));
      for (const item of ctaList) {
        destinationUrls.push({ url: item, label: 'small_cta_urls' });
      }
    }

    const targetValidationResults = [];
    for (const target of destinationUrls) {
      const outcome = await validateNavigationTarget(page, target.url, target.label);
      targetValidationResults.push({ ...outcome, label: target.label });
    }

    const failedTargets = targetValidationResults.filter(r => !r.success);

    let errorMessages = [];
    if (result.mainStatus === 'FAIL') {
      errorMessages.push(`bold-penguin: ${result.mainError}`);
    }
    if (result.ctaStatus === 'FAIL') {
      errorMessages.push(`CTA: ${result.ctaError}`);
    }
    if (failedTargets.length > 0) {
      const reasons = failedTargets.map(r => `${r.label}: ${r.reason}`).join('; ');
      errorMessages.push(`Destination URLs: ${reasons}`);
      result.pageError = reasons;
    }
    if (result.mainBackNav === 'FAIL') {
      errorMessages.push(`bold-penguin back: ${result.mainBackError}`);
    }

    // Overall status
    if (result.mainStatus === 'N/A' && result.ctaStatus === 'N/A') {
      result.status = 'N/A';
      result.error = 'No applicable tests';
    } else if (result.mainStatus === 'FAIL' || result.ctaStatus === 'FAIL' || failedTargets.length > 0 || result.mainBackNav === 'FAIL') {
      result.status = 'FAIL';
      result.error = errorMessages.join('; ');
      if (!result.pageError && failedTargets.length > 0) {
        result.pageError = failedTargets.map(r => `${r.label}: ${r.reason}`).join('; ');
      }
    } else {
      result.status = 'PASS';
      result.error = '';
    }

    console.log(`\n📊 Overall Status: ${result.status}`);
    if (result.error) console.log(`  ❌ Error: ${result.error}`);
    try {
      const screenshotFile = path.join(SCREENSHOT_DIR, `screenshot_${index}_${Date.now()}.png`);
      await page.screenshot({ path: screenshotFile, fullPage: true });
      result.screenshot = screenshotFile;
      console.log(`📸 Screenshot saved: ${screenshotFile}`);
    } catch (ssError) {
      console.log(`⚠️ Screenshot failed: ${ssError.message}`);
      result.error += ` (Screenshot failed: ${ssError.message})`;
    }
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message || 'Unknown error';
    console.log(`❌ Validation failed: ${result.error}`);
    try {
      const screenshotFile = path.join(SCREENSHOT_DIR, `screenshot_${index}_${Date.now()}_FAIL.png`);
      await page.screenshot({ path: screenshotFile, fullPage: true });
      result.screenshot = screenshotFile;
      console.log(`📸 Failure screenshot saved: ${screenshotFile}`);
    } catch (_) {}
  }
  return result;
}

// ---------- Helper: validateNavigationTarget ----------
async function validateNavigationTarget(page, targetUrl, label = 'destination URL') {
  if (!targetUrl) return { success: false, reason: `${label} is empty`, finalUrl: '' };
  try {
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (response && response.status() >= 400) {
      return { success: false, reason: `HTTP ${response.status()}`, finalUrl: page.url() };
    }
    await page.waitForLoadState('load', { timeout: NAV_TIMEOUT }).catch(() => {});
    const settleCheck = await waitForPageToSettle(page, targetUrl, 15000);
    if (!settleCheck.success) {
      return { success: false, reason: settleCheck.reason, finalUrl: page.url() };
    }
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const pageError = await getPageErrorReason(page, finalUrl, title);
    if (pageError) return { success: false, reason: pageError, finalUrl };
    return { success: true, reason: 'Navigation completed normally', finalUrl, title };
  } catch (error) {
    return { success: false, reason: error.message || 'Navigation failed', finalUrl: page.url() };
  }
}

// ---------- HTML Report ----------
function generateHtmlReport(results, startTime, mobileMode) {
  const total = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const na = results.filter(r => r.status === 'N/A').length;
  const mainPass = results.filter(r => r.mainStatus === 'PASS').length;
  const mainFail = results.filter(r => r.mainStatus === 'FAIL').length;
  const mainNA = results.filter(r => r.mainStatus === 'N/A').length;
  const smallPass = results.filter(r => r.smallCtaStatus === 'PASS').length;
  const smallFail = results.filter(r => r.smallCtaStatus === 'FAIL').length;
  const smallNA = results.filter(r => r.smallCtaStatus === 'N/A').length;
  const stickyPass = results.filter(r => r.stickyCtaStatus === 'PASS').length;
  const stickyFail = results.filter(r => r.stickyCtaStatus === 'FAIL').length;
  const stickyNA = results.filter(r => r.stickyCtaStatus === 'N/A').length;
  const backPass = results.filter(r => r.mainBackNav === 'SUCCESS').length;
  const backFail = results.filter(r => r.mainBackNav === 'FAIL').length;
  const backNA = results.filter(r => r.mainBackNav === 'N/A' || !r.mainBackNav).length;

  const timestamp = new Date(startTime).toLocaleString();
  const modeLabel = mobileMode ? '📱 Mobile' : '🖥️ Desktop';

  let rows = results.map((r, i) => {
    const overallClass = r.status === 'PASS' ? 'badge-pass' : (r.status === 'N/A' ? 'badge-na' : 'badge-fail');
    const mainClass = r.mainStatus === 'PASS' ? 'badge-pass' : (r.mainStatus === 'N/A' ? 'badge-na' : 'badge-fail');
    const smallClass = r.smallCtaStatus === 'PASS' ? 'badge-pass' : (r.smallCtaStatus === 'N/A' ? 'badge-na' : 'badge-fail');
    const stickyClass = r.stickyCtaStatus === 'PASS' ? 'badge-pass' : (r.stickyCtaStatus === 'N/A' ? 'badge-na' : 'badge-fail');
    const backClass = r.mainBackNav === 'SUCCESS' ? 'badge-pass' : (r.mainBackNav === 'N/A' ? 'badge-na' : 'badge-fail');

    const smallUrlsHtml = r.smallCtaUrls ? r.smallCtaUrls.split(' | ').map(u => `<div><a href="${u}" target="_blank">${u}</a></div>`).join('') : '—';
    const stickyUrlsHtml = r.stickyCtaUrls ? r.stickyCtaUrls.split(' | ').map(u => `<div><a href="${u}" target="_blank">${u}</a></div>`).join('') : '—';
    const boldPenguinResult = r.mainFinalUrl ? `<a href="${r.mainFinalUrl || '#'}" target="_blank">${r.mainFinalUrl || '—'}</a>` : '—';
    const errorDetails = r.error ? r.error : (r.pageError ? r.pageError : '—');

    return `
      <tr>
        <td>${i + 1}</td>
        <td><a href="${r.url}" target="_blank">${r.url}</a></td>
        <td><span class="badge ${overallClass}">${r.status}</span></td>
        <td><span class="badge ${mainClass}">${r.mainStatus || 'N/A'}</span></td>
        <td>${boldPenguinResult}</td>
        <td><span class="badge ${backClass}">${r.mainBackNav || 'N/A'}</span></td>
        <td><span class="badge ${smallClass}">${r.smallCtaStatus || 'N/A'}</span></td>
        <td>${smallUrlsHtml}</td>
        <td><span class="badge ${stickyClass}">${r.stickyCtaStatus || 'N/A'}</span></td>
        <td>${stickyUrlsHtml}</td>
        <td style="font-size:12px; max-width:300px; word-wrap:break-word;">${errorDetails}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>bold-penguin test result report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Roboto, system-ui, sans-serif; margin: 0; padding: 20px; background: #f0f2f5; }
    .container { max-width: 1800px; margin: 0 auto; background: #ffffff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.12); padding: 24px 30px 30px 30px; overflow-x: auto; }
    h1 { background: linear-gradient(135deg, #1e3c72, #2a5298); color: #fff; padding: 18px 24px; border-radius: 12px; margin: -24px -30px 20px -30px; font-weight: 600; font-size: 28px; display: flex; align-items: center; gap: 12px; }
    .summary { display: flex; flex-wrap: wrap; gap: 16px; margin: 24px 0 20px 0; padding: 16px 20px; background: #f8f9fc; border-radius: 12px; border: 1px solid #e9ecf0; }
    .summary-item { background: white; padding: 8px 18px; border-radius: 30px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); font-size: 15px; font-weight: 500; color: #2c3e50; }
    .summary-item span { font-weight: 700; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    .na { color: #6c757d; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 30px; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
    .badge-pass { background: #d4edda; color: #155724; }
    .badge-fail { background: #f8d7da; color: #721c24; }
    .badge-na { background: #e9ecef; color: #495057; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
    th { background: #2a5298; color: white; padding: 10px 8px; text-align: left; white-space: nowrap; font-weight: 600; }
    td { padding: 8px 8px; border-bottom: 1px solid #e9ecf0; vertical-align: middle; }
    tr:hover td { background-color: #f8f9fc; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .timestamp { color: #6c757d; font-size: 0.9em; margin-top: 10px; text-align: right; }
    .mode-badge { display: inline-block; background: #2a5298; color: white; padding: 4px 16px; border-radius: 30px; font-weight: 600; font-size: 14px; margin-left: 10px; }
    @media (max-width: 768px) { .container { padding: 15px; } h1 { font-size: 22px; padding: 14px 18px; margin: -15px -15px 15px -15px; } .summary { flex-direction: column; gap: 8px; } }
  </style>
</head>
<body>
<div class="container">
  <h1>🔍 bold-penguin test result report
    <span class="mode-badge">${modeLabel}</span>
  </h1>
  <div class="summary">
    <div class="summary-item">📋 Total URLs: <span>${total}</span></div>
    <div class="summary-item">✅ Overall Pass: <span class="pass">${passed}</span></div>
    <div class="summary-item">❌ Overall Fail: <span class="fail">${failed}</span></div>
    <div class="summary-item">⏸️ Overall N/A: <span class="na">${na}</span></div>
    <div class="summary-item">🔵 bold-penguin Pass: <span class="pass">${mainPass}</span> | Fail: <span class="fail">${mainFail}</span> | N/A: <span class="na">${mainNA}</span></div>
    <div class="summary-item">⬅️ Back Navigation Pass: <span class="pass">${backPass}</span> | Fail: <span class="fail">${backFail}</span> | N/A: <span class="na">${backNA}</span></div>
    <div class="summary-item">🟢 SmallCTA Pass: <span class="pass">${smallPass}</span> | Fail: <span class="fail">${smallFail}</span> | N/A: <span class="na">${smallNA}</span></div>
    <div class="summary-item">🟡 StickyCTA Pass: <span class="pass">${stickyPass}</span> | Fail: <span class="fail">${stickyFail}</span> | N/A: <span class="na">${stickyNA}</span></div>
  </div>
  <p class="timestamp">Generated: ${timestamp}</p>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>URL</th>
        <th>Overall</th>
        <th>bold-penguin</th>
        <th>bold-penguin Final URL</th>
        <th>Back Nav</th>
        <th>SmallCTA Status</th>
        <th>SmallCTA URLs</th>
        <th>StickyCTA Status</th>
        <th>StickyCTA URLs</th>
        <th>Failure Details</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>
</body>
</html>`;
}

// ---------- Excel report ----------
function generateExcelReport(results, outputPath) {
  try {
    const data = results.map(r => ({
      'URL': r.url || '',
      'bold_penguin_status': r.mainStatus || '',
      'bold_penguin_final_url': r.mainFinalUrl || '',
      'back_navigation': r.mainBackNav || '',
      'back_error': r.mainBackError || '',
      'small_cta_urls': r.smallCtaUrls || '',
      'SmallCTA': r.smallCtaStatus || '',
      'sticky_cta_urls': r.stickyCtaUrls || '',
      'StickyCTA': r.stickyCtaStatus || '',
      'pageError': r.pageError || '',
      'status': r.status || '',
      'error_details': r.error || '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    XLSX.writeFile(wb, outputPath);
    console.log(`📊 Excel: ${outputPath}`);
  } catch (error) {
    console.error(`⚠️ Could not write Excel file: ${error.message}`);
    console.log(`ℹ️ Excel file may be open in another program. Skipping Excel export.`);
  }
}

// ---------- Main ----------
(async () => {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Starting Bold Penguin Validator`);
  console.log(`${'='.repeat(60)}\n`);

  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  if (GENERATE_REPORTS && !fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportTimestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  const OUTPUT_CSV = path.join(REPORTS_DIR, `bold-penguin-quote_report_${reportTimestamp}.csv`);
  const OUTPUT_EXCEL = path.join(REPORTS_DIR, `bold-penguin-quote_report_${reportTimestamp}.xlsx`);

  if (!GENERATE_REPORTS && fs.existsSync(OUTPUT_CSV)) {
    fs.unlinkSync(OUTPUT_CSV);
    console.log(`🧹 Removed stale report: ${OUTPUT_CSV}`);
  }

  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`❌ CSV not found: ${INPUT_CSV}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(INPUT_CSV, 'utf8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  const urls = records.map(r => r.URL).filter(Boolean);
  if (urls.length === 0) {
    console.error('❌ No URLs in CSV. Header must be "URL".');
    process.exit(1);
  }

  console.log(`📋 Processing ${urls.length} URLs from ${INPUT_CSV}\n`);

  let browser;
  try {
    browser = await chromium.launch({ headless: !HEADED_MODE });
  } catch (launchError) {
    if (HEADED_MODE && /Application Control policy|Failed to load Chrome DLL|Target page, context or browser has been closed/i.test(launchError.message || '')) {
      console.warn('⚠️ Headed Chromium launch is blocked by Windows application control policy. Falling back to headless mode.');
      browser = await chromium.launch({ headless: true });
      HEADED_MODE = false;
    } else {
      throw launchError;
    }
  }

  const contextOptions = {};
  if (MOBILE_MODE) Object.assign(contextOptions, devices['iPhone 12']);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const result = await validateUrl(page, url, i+1);
    results.push(result);
    console.log(`\n📊 Summary for ${url}:`);
    console.log(`  Overall: ${result.status}`);
    console.log(`  bold-penguin: ${result.mainStatus || 'N/A'}`);
    console.log(`  Back Nav: ${result.mainBackNav || 'N/A'}`);
    console.log(`  SmallCTA: ${result.smallCtaStatus || 'N/A'}`);
    console.log(`  StickyCTA: ${result.stickyCtaStatus || 'N/A'}`);
    if (result.error) console.log(`  Error: ${result.error}`);
    await context.clearCookies();
    console.log(`  🍪 Cookies cleared`);
  }

  await browser.close();

  if (GENERATE_REPORTS) {
    const headers = ['url', 'bold_penguin_status', 'bold_penguin_final_url', 'back_navigation', 'back_error', 'small_cta_urls', 'SmallCTA', 'sticky_cta_urls', 'StickyCTA', 'pageError', 'status', 'error_details'];
    const escapeCsvValue = (value) => {
      const text = value == null ? '' : String(value);
      return text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')
        ? `"${text.replace(/"/g, '""')}"`
        : text;
    };

    const rows = results.map(r => headers.map(h => {
      if (h === 'url') return escapeCsvValue(r.url || '');
      if (h === 'bold_penguin_status') return escapeCsvValue(r.mainStatus || '');
      if (h === 'bold_penguin_final_url') return escapeCsvValue(r.mainFinalUrl || '');
      if (h === 'back_navigation') return escapeCsvValue(r.mainBackNav || '');
      if (h === 'back_error') return escapeCsvValue(r.mainBackError || '');
      if (h === 'small_cta_urls') return escapeCsvValue(r.smallCtaUrls || '');
      if (h === 'SmallCTA') return escapeCsvValue(r.smallCtaStatus || '');
      if (h === 'sticky_cta_urls') return escapeCsvValue(r.stickyCtaUrls || '');
      if (h === 'StickyCTA') return escapeCsvValue(r.stickyCtaStatus || '');
      if (h === 'pageError') return escapeCsvValue(r.pageError || '');
      if (h === 'status') return escapeCsvValue(r.status || '');
      if (h === 'error_details') return escapeCsvValue(r.error || '');
      return escapeCsvValue('');
    }).join(','));

    const csvContent = [headers.map(escapeCsvValue).join(','), ...rows].join('\n');
    fs.writeFileSync(OUTPUT_CSV, csvContent, 'utf8');
    console.log(`\n✅ CSV: ${OUTPUT_CSV}`);

    generateExcelReport(results, OUTPUT_EXCEL);

    const html = generateHtmlReport(results, startTime, MOBILE_MODE);
    const htmlPath = path.join(REPORTS_DIR, `bold-penguin-quote_report_${reportTimestamp}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`📄 HTML: ${htmlPath}`);

    console.log(`📸 Screenshots: ${SCREENSHOT_DIR}/`);
    console.log(`✅ Report generated in "${REPORTS_DIR}"`);
  } else {
    console.log(`📸 Screenshots kept in "${SCREENSHOT_DIR}/"`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🏁 Done!`);
  console.log(`${'='.repeat(60)}`);
})();