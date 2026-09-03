const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');

// ------------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------------

// Mapping of known button texts to their expected target URLs.
// This is derived from the requirement; extra buttons will be validated dynamically.
const EXPECTED_TARGETS = {
  'find an agent': 'https://agency.nationwide.com/',
  'get a quote now': 'https://www.hagerty.com/apps/manifold/init?aff=explink&ipds=999930123',
  'get flood insurance info': 'https://www.floodsmart.gov/',
  'get a quote': null,
  'get started': 'https://qec.petinsurance.com/?OM=FR0037',
  'start your quote': null,
  'find a financial professional': null,
};

const EXPECTED_CTA_TEXTS = Object.keys(EXPECTED_TARGETS).map(key => key.toLowerCase());

function isDynamicCtaCandidate({ text, ariaText, titleText, href }) {
  const combined = `${text || ''} ${ariaText || ''} ${titleText || ''} ${href || ''}`.trim();
  if (!combined) return false;

  const cleaned = combined.toLowerCase();
  if (!cleaned) return false;

  const excludedTokens = [
    'menu', 'navigation', 'home', 'logo', 'skip', 'close', 'previous', 'next', 'search',
    'login', 'register', 'sign in', 'sign up', 'call us', 'chat', 'cookie',
    'feedback', 'qualtrics', 'survey', 'accept', 'manage settings', 'facebook', 'instagram',
    'careers', 'privacy', 'accessibility', 'terms', 'help center', 'for agents', 'institutional investors',
    'pension administrator', 'california consumer privacy act', 'brokercheck', 'en español', 'finra'
  ];

  const actionKeywords = [
    'quote', 'agent', 'start', 'get', 'find', 'learn', 'continue', 'buy', 'apply', 'claim',
    'view', 'compare', 'talk', 'contact', 'insurance', 'policy', 'coverages', 'discover', 'request',
    'button'
  ];

  if (excludedTokens.some(token => cleaned.includes(token))) return false;
  if (href && /^(javascript:|#)/i.test(href)) return false;
  if (href && /(qualtrics|survey|feedback)/i.test(href)) return false;
  if (!text && !ariaText && !titleText && !href) return false;

  const hasActionKeyword = actionKeywords.some(keyword => cleaned.includes(keyword));
  return hasActionKeyword;
}

function isBannerLinkCandidate({ text, ariaText, titleText, href }) {
  if (isDynamicCtaCandidate({ text, ariaText, titleText, href })) return true;
  if (!href || /^(javascript:|#|tel:|mailto:|sms:|callto:)/i.test(href)) return false;

  const label = `${text || ''} ${ariaText || ''} ${titleText || ''}`.trim();
  return Boolean(label) && (/^https?:\/\//i.test(href) || href.startsWith('/'));
}

function isBannerButtonElement(el, text, ariaText, href) {
  const tagName = (el && el.evaluate) ? '' : '';
  const elTag = (el && typeof el.evaluate === 'function') ? '' : '';
  return isDynamicCtaCandidate({ text, ariaText, titleText: '', href });
}

async function isBreadcrumbElement(el) {
  return el.evaluate((node) => {
    const breadcrumbPattern = /breadcrumb|bread-crumb/i;
    let current = node;
    while (current && current !== document.body) {
      const identity = [
        current.tagName || '',
        current.id || '',
        typeof current.className === 'string' ? current.className : '',
        current.getAttribute?.('aria-label') || '',
        current.getAttribute?.('data-component') || '',
        current.getAttribute?.('data-testid') || '',
      ].join(' ');
      if (breadcrumbPattern.test(identity)) return true;
      current = current.parentElement;
    }
    return false;
  }).catch(() => false);
}

function normalizeButtonText(value) {
  return normalizeText(value || '');
}

async function getButtonText(el) {
  const directText = normalizeButtonText(
    await el.textContent().catch(() => '') || await el.innerText().catch(() => '')
  );
  if (directText) return directText;

  const ariaText = normalizeButtonText(await el.getAttribute('aria-label').catch(() => ''));
  if (ariaText) return ariaText;

  const titleText = normalizeButtonText(await el.getAttribute('title').catch(() => ''));
  if (titleText) return titleText;

  const href = await el.getAttribute('href').catch(() => '');
  if (!href) return '';

  const lastPathSegment = href.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
  if (lastPathSegment.toLowerCase() === 'about') return 'About us';
  return lastPathSegment.replace(/[-_]+/g, ' ');
}

// CSV column names (adjust if your CSV uses different headers)
const CSV_COLUMN_SOURCE_URL = 'source_url';
const FALLBACK_CSV_COLUMN_SOURCE_URL = 'url';
const CSV_COLUMN_BANNER_SELECTOR = 'banner_selector'; // optional

// Default banner selector – override per URL via CSV column 'banner_selector'
const DEFAULT_BANNER_SELECTOR = '[data-component="Banner"], [class*="banner"], [id*="banner"]';

// Timeouts and retries
const NAVIGATION_TIMEOUT = 30000;
const DESTINATION_LOAD_TIMEOUT = 30000;
const NAVIGATION_WAIT_TIMEOUT = 10000;
const CLICK_TIMEOUT = 5000;
const STALE_RETRIES = 3;

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

/**
 * Sleep for given milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize text for matching (lowercase, trimmed).
 */
function normalizeText(text) {
  return text ? text.trim().toLowerCase() : '';
}

function normalizeUrlForComparison(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.origin}${pathname}`.replace(/\/$/, '').toLowerCase();
  } catch (e) {
    return String(url || '').replace(/\/$/, '').toLowerCase();
  }
}

function isSystemActionHref(href) {
  return /^(tel:|mailto:|sms:|callto:)/i.test(String(href || '').trim());
}

async function validateDestinationApi(context, destinationUrl) {
  if (!/^https?:\/\//i.test(destinationUrl || '')) {
    return { applicable: false, success: true, status: 'N/A', reason: 'API check not applicable to a non-HTTP destination.' };
  }

  const startedAt = Date.now();
  try {
    const response = await context.request.get(destinationUrl, {
      timeout: DESTINATION_LOAD_TIMEOUT,
      maxRedirects: 10,
    });
    const status = response.status();
    const finalUrl = response.url();
    const durationMs = Date.now() - startedAt;
    if (status >= 400) {
      return {
        applicable: true,
        success: false,
        status,
        finalUrl,
        durationMs,
        reason: `API HTTP error: GET ${destinationUrl} returned ${status}; final URL: ${finalUrl}`,
      };
    }
    return {
      applicable: true,
      success: true,
      status,
      finalUrl,
      durationMs,
      reason: `API check passed: GET returned ${status} in ${durationMs} ms; final URL: ${finalUrl}`,
    };
  } catch (error) {
    return {
      applicable: true,
      success: false,
      status: 'ERROR',
      durationMs: Date.now() - startedAt,
      reason: `API navigation failure: GET ${destinationUrl} failed: ${error.message}`,
    };
  }
}

async function validateDestinationPage(page, pageErrors, httpErrors) {
  let loadTimedOut = false;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: DESTINATION_LOAD_TIMEOUT });
  } catch (error) {
    return { success: false, reason: `Destination page load timeout: ${error.message}` };
  }

  try {
    await page.waitForLoadState('load', { timeout: DESTINATION_LOAD_TIMEOUT });
  } catch (error) {
    loadTimedOut = true;
  }

  if (httpErrors.length > 0) {
    return { success: false, reason: `HTTP error: ${httpErrors.join('; ')}` };
  }

  const loadingDeadline = Date.now() + DESTINATION_LOAD_TIMEOUT;
  let usable;
  do {
    usable = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { loading: true, hasContent: false, errorText: false };

      const loadingSelectors = [
        '[aria-busy="true"]', '[role="progressbar"]',
        '[class*="spinner"]', '[class*="loading"]',
        '[id*="spinner"]', '[id*="loading"]'
      ];
      const loading = loadingSelectors.some(selector =>
        Array.from(body.querySelectorAll(selector)).some(node => {
          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().width > 0;
        })
      );
      const text = (body.innerText || '').trim();
      const headingText = Array.from(body.querySelectorAll('h1, [role="heading"]'))
        .map(node => (node.innerText || '').trim())
        .join(' ');
      const titleText = document.title || '';
      const errorText = /^(404|403|500|502|503|504)\b|page not found|service unavailable/i.test(`${titleText} ${headingText}`);
      return { loading, hasContent: text.length > 0, errorText };
    }).catch(error => ({ loading: false, hasContent: false, errorText: false, evaluationError: error.message }));

    if (usable.evaluationError || usable.errorText || (!usable.loading && usable.hasContent)) break;
    await sleep(1000);
  } while (Date.now() < loadingDeadline);

  if (usable.evaluationError) {
    return { success: false, reason: `Destination page usability check failed: ${usable.evaluationError}` };
  }
  if (usable.loading) {
    return { success: false, reason: 'Continuous loading: destination page still shows a loading indicator after the allowed wait.' };
  }
  if (!usable.hasContent) {
    return { success: false, reason: 'Destination page loaded without usable page content.' };
  }
  if (usable.errorText) {
    return { success: false, reason: 'Destination page displays an HTTP or page error message.' };
  }
  if (/^(chrome-error|about:neterror|about:blank)/i.test(page.url())) {
    return { success: false, reason: `Browser/page error: destination ended at ${page.url()}.` };
  }

  if (pageErrors.length > 0) {
    return {
      success: true,
      reason: `Destination page loaded and is usable.${loadTimedOut ? ' Browser load event timed out, but usable content was available.' : ''} Non-blocking browser/page warning: ${pageErrors.join('; ')}`
    };
  }

  return {
    success: true,
    reason: `Destination page loaded and is usable.${loadTimedOut ? ' Browser load event timed out, but usable content was available.' : ''}`
  };
}

async function safeGoto(page, url) {
  const waitStrategies = ['domcontentloaded', 'networkidle', 'load'];
  let lastError = null;

  for (const waitUntil of waitStrategies) {
    try {
      await page.goto(url, { waitUntil, timeout: NAVIGATION_TIMEOUT });
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`[NAVIGATION] page.goto waitUntil=${waitUntil} failed for ${url}:`, error.message);
    }
  }

  console.warn(`[NAVIGATION] Final fallback page.goto failed for ${url}. Last error: ${lastError ? lastError.message : 'unknown'}`);
  return false;
}

async function handleConsentBanner(page) {
  const consentSelectors = [
    '#truste-consent-content',
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Accept all")',
  ];

  for (const selector of consentSelectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
        await el.click({ timeout: CLICK_TIMEOUT }).catch(() => {});
        await page.waitForTimeout(1000).catch(() => {});
        return true;
      }
    } catch (e) {
      // Ignore selector mismatches and move on
    }
  }

  return false;
}

/**
 * Locate the banner container on the page.
 * If a custom selector is provided, use it; otherwise fallback to default.
 */
async function getBannerContainer(page, customSelector) {
  const selectors = [];
  if (customSelector) selectors.push(customSelector);
  selectors.push(
    '[data-component*="Banner"]',
    '[data-component*="banner"]',
    '[data-testid*="banner"]',
    '[data-component*="Hero"]',
    '[data-component*="hero"]',
    '[class*="hero"]',
    '[class*="banner"]',
    '[id*="banner"]',
    '[id*="hero"]',
    'main',
    'header',
    DEFAULT_BANNER_SELECTOR,
  );

  for (const selector of selectors) {
    try {
      const containers = await page.locator(selector).all();
      for (const container of containers) {
        const buttonCandidates = container.locator('button, input[type="button"], input[type="submit"], [role="button"], a[href]');
        const count = await buttonCandidates.count();
        for (let i = 0; i < count; i++) {
          const el = buttonCandidates.nth(i);
          const isVisible = await el.isVisible().catch(() => false);
          const isEnabled = await el.isEnabled().catch(() => true);
          if (!isVisible || !isEnabled || await isBreadcrumbElement(el)) continue;

          const text = normalizeButtonText(await el.textContent().catch(() => ''));
          const ariaText = normalizeButtonText(await el.getAttribute('aria-label').catch(() => ''));
          const titleText = normalizeButtonText(await el.getAttribute('title').catch(() => ''));
          const href = await el.getAttribute('href').catch(() => '');
          if (isSystemActionHref(href) || isBannerLinkCandidate({ text, ariaText, titleText, href })) {
            return container;
          }
        }
      }
    } catch (e) {
      // Ignore selector-mismatch issues and try the next candidate.
    }
  }

  return null;
}

/**
 * Discover all interactive elements (buttons, links with button role, etc.)
 * within the given container.
 */
async function discoverInteractiveElements(container) {
  const allPossible = await container.locator(`
    button,
    input[type="button"],
    input[type="submit"],
    input[type="reset"],
    [role="button"],
    a[href]
  `).all();

  const visibleEnabled = [];
  for (const el of allPossible) {
    const isVisible = await el.isVisible().catch(() => false);
    const isEnabled = await el.isEnabled().catch(() => true);
    if (!isVisible || !isEnabled || await isBreadcrumbElement(el)) continue;

    const text = normalizeText(await el.textContent().catch(() => ''));
    const ariaText = normalizeText(await el.getAttribute('aria-label').catch(() => ''));
    const titleText = normalizeText(await el.getAttribute('title').catch(() => ''));
    const href = await el.getAttribute('href').catch(() => '');

    const tagName = (await el.evaluate(node => node.tagName).catch(() => '')).toLowerCase();
    if (tagName && !['button', 'input', 'a'].includes(tagName) && !await el.getAttribute('role').catch(() => '')) {
      continue;
    }

    if (!isSystemActionHref(href) && !isBannerLinkCandidate({ text, ariaText, titleText, href })) continue;

    const metrics = await el.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        tagName: node.tagName.toLowerCase(),
        role: node.getAttribute('role') || '',
        className: typeof node.className === 'string' ? node.className : '',
        testAttribute: node.getAttribute('data-test') || '',
      };
    }).catch(() => ({ top: 99999, left: 0, width: 0, height: 0, tagName: '', role: '', className: '', testAttribute: '' }));

    const buttonSemantics = ((metrics.tagName === 'button' ? 100 : 0) +
      (metrics.role === 'button' ? 90 : 0) +
      (/button|cta/i.test(`${metrics.className} ${metrics.testAttribute}`) ? 80 : 0));
    const priority = (buttonSemantics +
      (metrics.top < 500 ? 20 : 0) +
      (metrics.width > 120 ? 10 : 0));

    visibleEnabled.push({ el, priority });
  }

  visibleEnabled.sort((a, b) => b.priority - a.priority);
  return visibleEnabled.slice(0, 1).map(item => item.el);
}

/**
 * Click an element and handle navigation (same tab, new tab/window).
 * Returns an object with navigation details.
 */
async function clickAndValidateNavigation(page, element, expectedTarget) {
  const result = {
    initialUrl: page.url(),
    finalUrl: null,
    navigationType: null,
    newTabOpened: false,
    apiStatus: 'N/A',
    apiFinalUrl: null,
    apiResponseTimeMs: null,
    apiDetails: 'API check not run yet.',
    consentHandled: false,
    error: null,
    success: false,
  };

  console.log('');
  console.log('=== CTA NAVIGATION CHECK START ===');
  console.log('[NAVIGATION] Expected target:', expectedTarget || 'Not specified');

  const context = page.context();
  const initialPages = new Set(context.pages());
  const pageErrors = [];
  const httpErrors = [];
  const pageErrorHandler = error => pageErrors.push(error.message);
  const responseHandler = response => {
    if (response.request().resourceType() === 'document' && response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  };
  page.on('pageerror', pageErrorHandler);
  page.on('response', responseHandler);
  const popupPromise = context.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
  const hrefValue = await element.getAttribute('href').catch(() => '');

  // Click the element with retry for stale elements
  let clickSuccess = false;
  for (let attempt = 0; attempt < STALE_RETRIES; attempt++) {
    try {
      console.log(`[NAVIGATION] Attempt ${attempt + 1}/${STALE_RETRIES} clicking CTA`);
      await element.click({ timeout: CLICK_TIMEOUT });
      clickSuccess = true;
      break;
    } catch (e) {
      if (e.message.includes('stale')) {
        console.warn('[NAVIGATION] Stale element; retrying...');
        await sleep(200);
        continue;
      }
      throw e;
    }
  }
  if (!clickSuccess) {
    result.error = 'Failed to click element after retries';
    console.error('[NAVIGATION] Failed to click CTA after retries.');
    return result;
  }

  // tel/mailto/sms links may open a browser or operating-system app chooser
  // without changing the page URL. The click itself is the expected behavior.
  if (isSystemActionHref(hrefValue)) {
    result.finalUrl = result.initialUrl;
    result.navigationType = 'System/App Action';
    result.success = true;
    console.log('[NAVIGATION] System/app action triggered successfully:', hrefValue);
    page.off('pageerror', pageErrorHandler);
    page.off('response', responseHandler);
    return result;
  }

  console.log('[NAVIGATION] CTA click succeeded. Waiting for navigation response...');
  console.log('[NAVIGATION] Current URL after click:', page.url());

  // Observe URL changes and newly opened pages. This also supports SPA/history navigation,
  // which does not always emit Playwright's traditional navigation event.
  let newPage = null;
  const observationDeadline = Date.now() + NAVIGATION_WAIT_TIMEOUT;
  while (Date.now() < observationDeadline) {
    const pagesAfterClick = context.pages();
    newPage = pagesAfterClick.find(candidate => !initialPages.has(candidate)) || null;
    if (newPage || page.url() !== result.initialUrl) break;
    await sleep(250);
  }

  if (!newPage) {
    newPage = await Promise.race([
      popupPromise,
      (async () => {
        while (Date.now() < observationDeadline) {
          const candidate = context.pages().find(item => !initialPages.has(item));
          if (candidate) return candidate;
          await sleep(250);
        }
        return null;
      })(),
    ]);
  }

  if (newPage) {
    console.log('[NAVIGATION] New tab/window detected during navigation observation.');
  } else if (page.url() !== result.initialUrl) {
    console.log('[NAVIGATION] Same-tab URL change detected during navigation observation.');
  } else {
    console.log('[NAVIGATION] No new page or URL change detected within the navigation wait period.');
  }

  // Check once more for a popup created at the end of the observation window.
  if (!newPage) {
    const finalPage = context.pages().find(candidate => !initialPages.has(candidate));
    if (finalPage) {
      newPage = finalPage;
    }
  }

  let targetPage = page;
  if (newPage) {
    result.newTabOpened = true;
    targetPage = newPage;
    console.log('[NAVIGATION] New tab/window detected. Waiting for new page load...');
    console.log('[NAVIGATION] Popup URL detected:', targetPage.url());
  } else {
    targetPage = page;
  }

  // Get final URL
  result.finalUrl = targetPage.url();
  console.log('[NAVIGATION] Final URL determined:', result.finalUrl);

  // Fallback for links that target an external popup/redirect but the page event is not captured reliably.
  if (expectedTarget && hrefValue) {
    try {
      const hrefTarget = new URL(hrefValue, result.initialUrl).href;
      if (normalizeUrlForComparison(hrefTarget) === normalizeUrlForComparison(expectedTarget)) {
        result.finalUrl = hrefTarget;
        result.newTabOpened = true;
        result.navigationType = 'Popup/External Link';
        if (!newPage) {
          targetPage = await context.newPage();
          const targetLoaded = await safeGoto(targetPage, hrefTarget);
          if (!targetLoaded) {
            result.error = `Navigation failure: target URL could not be loaded: ${hrefTarget}`;
          }
        }
        console.log('[NAVIGATION] CTA target URL matched the expected href fallback:', hrefTarget);
      }
    } catch (e) {
      // Ignore invalid href parsing and continue with the normal validation path below.
    }
  }

  // Determine navigation type
  if (result.newTabOpened) {
    result.navigationType = 'New Tab/Window';
  } else if (result.finalUrl !== result.initialUrl) {
    result.navigationType = 'Same Tab (Navigated)';
  } else {
    result.navigationType = 'No Navigation (Click triggered other action)';
  }

  // Validate the target URL before checking destination usability.
  if (expectedTarget) {
    if (normalizeUrlForComparison(result.finalUrl) === normalizeUrlForComparison(expectedTarget)) {
      console.log('[NAVIGATION] Expected target matched successfully.');
    } else {
      result.error = `Final URL (${result.finalUrl}) does not match expected (${expectedTarget})`;
      console.error('[NAVIGATION] Target mismatch:', result.error);
    }
  }

  const apiResult = await validateDestinationApi(context, result.finalUrl);
  result.apiStatus = apiResult.status;
  result.apiFinalUrl = apiResult.finalUrl || null;
  result.apiResponseTimeMs = apiResult.durationMs ?? null;
  result.apiDetails = apiResult.reason;
  console.log('[API] Target URL check:', apiResult.reason);
  if (!apiResult.success) {
    result.error = apiResult.reason;
  }

  const destinationPageErrors = targetPage === page ? pageErrors : [];
  const destinationHttpErrors = targetPage === page ? httpErrors : [];
  const destinationPageErrorHandler = error => destinationPageErrors.push(error.message);
  const destinationResponseHandler = response => {
    if (response.request().resourceType() === 'document' && response.status() >= 400) {
      destinationHttpErrors.push(`${response.status()} ${response.url()}`);
    }
  };
  if (targetPage !== page) {
    targetPage.on('pageerror', destinationPageErrorHandler);
    targetPage.on('response', destinationResponseHandler);
  }

  if (!result.newTabOpened && result.finalUrl === result.initialUrl) {
    result.success = false;
    result.error = 'Navigation failure: clicking the Target URL did not produce a new page or a URL change within the allowed wait period.';
  } else if (result.error) {
    result.success = false;
  } else if (apiResult.status === 200) {
    result.success = true;
    result.successReason = `Target URL opened successfully and returned API status 200.`;
  } else {
    const destinationResult = await validateDestinationPage(targetPage, destinationPageErrors, destinationHttpErrors);
    result.success = destinationResult.success;
    result.successReason = destinationResult.reason;
    if (!destinationResult.success) {
      result.error = destinationResult.reason;
    }
  }

  // If new tab opened, close it after destination validation completes.
  if (result.newTabOpened && targetPage !== page) {
    await targetPage.close().catch(() => {});
  }

  if (targetPage !== page) {
    targetPage.off('pageerror', destinationPageErrorHandler);
    targetPage.off('response', destinationResponseHandler);
  }

  page.off('pageerror', pageErrorHandler);
  page.off('response', responseHandler);

  return result;
}

// ------------------------------------------------------------------
// MAIN VALIDATION FUNCTION
// ------------------------------------------------------------------

/**
 * Validate all CTAs in the banner on a given source URL.
 * Returns an array of result objects.
 */
async function validateBannerOnUrl(sourceUrl, bannerSelector) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];

  try {
    console.log('');
    console.log('=== PAGE VALIDATION START ===');
    console.log('[VALIDATION] Source URL:', sourceUrl);
    // Navigate to source URL
    await safeGoto(page, sourceUrl);
    console.log('[VALIDATION] Page navigation attempted. URL after load:', page.url());
    await handleConsentBanner(page);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    console.log('[VALIDATION] Page loaded. Looking for banner container...');

    // Locate banner container
    let container = null;
    for (let retry = 0; retry < 3 && !container; retry++) {
      container = await getBannerContainer(page, bannerSelector);
      if (!container) {
        console.warn(`[VALIDATION] Banner not found yet (attempt ${retry + 1}/3). Retrying after brief wait...`);
        await page.waitForTimeout(1500);
      }
    }
    const consentHandled = await handleConsentBanner(page);
    if (consentHandled) console.log('[VALIDATION] Consent banner handled before banner detection.');
    if (!container) {
      console.error('[VALIDATION] Banner container not found for:', sourceUrl);
      results.push({
        sourceUrl,
        buttonText: 'N/A',
        buttonPresent: false,
        expectedTarget: null,
        initialUrl: sourceUrl,
        finalUrl: null,
        navigationType: null,
        newTabOpened: false,
        consentHandled,
        functionalStatus: 'N/A',
        validationDetails: 'N/A: Banner component is not present on this page, so the banner-button requirement does not apply.',
        errorDetails: '',
        genuineIssue: false,
        component: 'Banner',
      });
      return results;
    }

    // Discover the strongest banner button candidate inside the banner only.
    const elements = await discoverInteractiveElements(container);
    console.log('[VALIDATION] Banner found. Banner button candidates discovered:', elements.length);
    console.log('[VALIDATION] Step: banner detected successfully.');
    if (elements.length === 0) {
      results.push({
        sourceUrl,
        buttonText: 'N/A',
        buttonPresent: false,
        expectedTarget: null,
        initialUrl: sourceUrl,
        finalUrl: null,
        navigationType: null,
        newTabOpened: false,
        consentHandled: await handleConsentBanner(page),
        functionalStatus: 'N/A',
        validationDetails: 'N/A: Banner component is present, but it contains no required button element to validate on this page.',
        errorDetails: '',
        genuineIssue: false,
        component: 'Banner',
      });
      return results;
    }

    const el = elements[0];
    let text = await getButtonText(el);
    console.log('[VALIDATION] Evaluating CTA text:', text || '(unnamed)');
    console.log('[VALIDATION] Step: CTA identified and being validated.');

    let expectedTarget = null;
    if (text && EXPECTED_TARGETS[text.toLowerCase()]) {
      expectedTarget = EXPECTED_TARGETS[text.toLowerCase()];
    }

    console.log('[VALIDATION] Running navigation validation for CTA:', text || '(unnamed)');
    console.log('[VALIDATION] Step: click + navigation validation started.');
    const navResult = await clickAndValidateNavigation(page, el, expectedTarget);

    const result = {
      sourceUrl,
      buttonText: text || '(unnamed)',
      buttonPresent: true,
      expectedTarget: expectedTarget || 'Not specified',
      initialUrl: navResult.initialUrl,
      finalUrl: navResult.finalUrl,
      navigationType: navResult.navigationType,
      newTabOpened: navResult.newTabOpened,
      apiStatus: navResult.apiStatus,
      apiFinalUrl: navResult.apiFinalUrl,
      apiResponseTimeMs: navResult.apiResponseTimeMs,
      apiDetails: navResult.apiDetails,
      consentHandled: !!(navResult.consentHandled || await handleConsentBanner(page)),
      functionalStatus: navResult.success ? 'PASS' : 'FAIL',
      validationDetails: navResult.success
        ? `PASS: ${navResult.successReason || 'Target URL opened and the destination page loaded successfully and is usable.'}`
        : `FAIL: ${navResult.error || 'Target URL did not produce a usable destination page.'}`,
      errorDetails: navResult.error || '',
      genuineIssue: !navResult.success,
      component: 'Banner',
      executionDuration: null,
    };
    results.push(result);
    console.log('[VALIDATION] CTA result:', result.functionalStatus, '|', result.validationDetails, '|', result.errorDetails || 'No error');

    if (!navResult.newTabOpened && page.url() !== sourceUrl) {
      await page.goBack({ timeout: 5000 }).catch(() => {});
      if (page.url() !== sourceUrl) {
        await safeGoto(page, sourceUrl);
        await handleConsentBanner(page);
      }
    }
    if (page.url() !== sourceUrl) {
      await safeGoto(page, sourceUrl);
      await handleConsentBanner(page);
    }
  } catch (error) {
    console.error('[VALIDATION] Unexpected validation error for:', sourceUrl, error);
    // Catch-all for any unexpected error
    results.push({
      sourceUrl,
      buttonText: 'N/A',
      buttonPresent: false,
      expectedTarget: null,
      initialUrl: sourceUrl,
      finalUrl: null,
      navigationType: null,
      newTabOpened: false,
      consentHandled: false,
      functionalStatus: 'FAIL',
      validationDetails: `FAIL: An unexpected error occurred during validation: ${error.message}`,
      errorDetails: error.message,
      genuineIssue: true,
      component: 'Banner',
    });
  } finally {
    console.log('[VALIDATION] Closing browser for source URL:', sourceUrl);
    await browser.close();
  }

  return results;
}

// ------------------------------------------------------------------
// REPORT GENERATION
// ------------------------------------------------------------------

/**
 * Generate Excel report from all results.
 */
async function generateExcelReport(allResults, outputPath) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Banner Validation');

  // Define columns
  worksheet.columns = [
    { header: 'Source URL', key: 'sourceUrl', width: 40 },
    { header: 'Component', key: 'component', width: 15 },
    { header: 'Button Text', key: 'buttonText', width: 25 },
    { header: 'Button Present', key: 'buttonPresent', width: 15 },
    { header: 'Target URL', key: 'finalUrl', width: 40 },
    { header: 'Result', key: 'functionalStatus', width: 15 },
    { header: 'Navigation Type', key: 'navigationType', width: 20 },
    { header: 'New Tab/Window', key: 'newTabOpened', width: 15 },
    { header: 'API Status', key: 'apiStatus', width: 12 },
    { header: 'API Final URL', key: 'apiFinalUrl', width: 40 },
    { header: 'API Response (ms)', key: 'apiResponseTimeMs', width: 18 },
    { header: 'API Details', key: 'apiDetails', width: 50 },
    { header: 'Genuine Issue', key: 'genuineIssue', width: 15 },
  ];

  // Add rows
  for (const result of allResults) {
    worksheet.addRow({
      sourceUrl: result.sourceUrl,
      component: result.component,
      buttonText: result.buttonText,
      buttonPresent: result.functionalStatus === 'N/A' ? 'N/A' : (result.buttonPresent ? 'Yes' : 'No'),
      finalUrl: result.finalUrl || result.expectedTarget || 'N/A',
      functionalStatus: result.functionalStatus,
      navigationType: result.navigationType,
      newTabOpened: result.newTabOpened ? 'Yes' : 'No',
      apiStatus: result.apiStatus || 'N/A',
      apiFinalUrl: result.apiFinalUrl || 'N/A',
      apiResponseTimeMs: result.apiResponseTimeMs ?? 'N/A',
      apiDetails: result.apiDetails || 'N/A',
      genuineIssue: result.genuineIssue ? 'Yes' : 'No',
    });
  }

  // Style header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };

  await workbook.xlsx.writeFile(outputPath);
}

/**
 * Generate HTML report from all results.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateHtmlReport(allResults, outputPath) {
  const total = allResults.length;
  const passed = allResults.filter(r => r.functionalStatus === 'PASS').length;
  const failed = allResults.filter(r => r.functionalStatus === 'FAIL').length;
  const notApplicable = allResults.filter(r => r.functionalStatus === 'N/A').length;
  const applicableResults = passed + failed;
  const passRate = applicableResults > 0 ? ((passed / applicableResults) * 100).toFixed(2) : 0;

  let rowsHtml = '';
  for (const r of allResults) {
    const status = r.functionalStatus || 'UNKNOWN';
    const statusClass = status === 'N/A' ? 'na' : status.toLowerCase();
    const buttonText = escapeHtml(r.buttonText || '(unnamed)');
    const sourceUrl = escapeHtml(r.sourceUrl || 'N/A');
    const targetUrl = escapeHtml(r.finalUrl || r.expectedTarget || 'Not specified');
    const navigationType = escapeHtml(r.navigationType || 'N/A');
    const apiStatus = escapeHtml(r.apiStatus || 'N/A');
    const apiFinalUrl = escapeHtml(r.apiFinalUrl || 'N/A');
    const apiResponseTimeMs = escapeHtml(r.apiResponseTimeMs ?? 'N/A');
    const apiDetails = escapeHtml(r.apiDetails || 'N/A');
    const genuineIssue = r.genuineIssue ? 'Yes' : 'No';
    const buttonPresent = r.functionalStatus === 'N/A' ? 'N/A' : (r.buttonPresent ? 'Yes' : 'No');

    rowsHtml += `
      <tr>
        <td>${sourceUrl}</td>
        <td>${escapeHtml(r.component || 'Banner')}</td>
        <td>${buttonText}</td>
        <td>${buttonPresent}</td>
        <td>${targetUrl}</td>
        <td><span class="status-badge ${statusClass}">${status}</span></td>
        <td>${navigationType}</td>
        <td>${r.newTabOpened ? 'Yes' : 'No'}</td>
        <td>${apiStatus}</td>
        <td>${apiFinalUrl}</td>
        <td>${apiResponseTimeMs}</td>
        <td>${apiDetails}</td>
        <td>${genuineIssue}</td>
      </tr>
    `;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Banner Component Button Report</title>
  <style>
    :root {
      --bg: #f4f7fb;
      --card: #ffffff;
      --line: #dfe7f1;
      --text: #1f2937;
      --muted: #5b6472;
      --pass: #169b62;
      --pass-bg: #eafaf2;
      --fail: #d93b3b;
      --fail-bg: #fff0f0;
      --skip: #d98c14;
      --skip-bg: #fff7eb;
      --info: #1f5ea8;
      --shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .container {
      max-width: 1500px;
      margin: 32px auto;
      padding: 0 20px 40px;
    }
    .header {
      background: linear-gradient(135deg, #0e2a47, #1f5ea8);
      color: #fff;
      border-radius: 14px;
      padding: 28px 30px;
      box-shadow: var(--shadow);
      margin-bottom: 24px;
    }
    .header h1 {
      margin: 0 0 8px;
      font-size: 32px;
      font-weight: 700;
    }
    .header p {
      margin: 0;
      opacity: 0.9;
      font-size: 14px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 18px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: var(--shadow);
      padding: 18px 20px;
    }
    .card-label {
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .card-value {
      font-size: 30px;
      font-weight: 700;
      color: var(--text);
    }
    .card-value.pass { color: var(--pass); }
    .card-value.fail { color: var(--fail); }
    .card-value.skip { color: var(--skip); }
    .card-value.info { color: var(--info); }
    .table-wrap {
      background: var(--card);
      border-radius: 12px;
      overflow-x: auto;
      overflow-y: hidden;
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }
    table {
      width: 100%;
      min-width: 1650px;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #eef4fb;
      color: #1a2a3a;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tbody tr:nth-child(even) { background: #fafcff; }
    tbody tr:hover { background: #f1f9ff; }
    .status-badge {
      display: inline-block;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .status-badge.pass {
      background: var(--pass-bg);
      color: var(--pass);
    }
    .status-badge.fail {
      background: var(--fail-bg);
      color: var(--fail);
    }
    .status-badge.na {
      background: #eef2f7;
      color: #465264;
    }
    .status-badge.skip {
      background: var(--skip-bg);
      color: var(--skip);
    }
    .status-badge.unknown {
      background: #eef2f7;
      color: #465264;
    }
    @media (max-width: 900px) {
      .container { padding: 0 12px 30px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Banner Component Button Functional Validation Report</h1>
      <p>Automation summary for banner button functionality checks across the provided URL set.</p>
    </div>

    <div class="summary-grid">
      <div class="card">
        <div class="card-label">Total</div>
        <div class="card-value info">${total}</div>
      </div>
      <div class="card">
        <div class="card-label">Passed</div>
        <div class="card-value pass">${passed}</div>
      </div>
      <div class="card">
        <div class="card-label">Failed</div>
        <div class="card-value fail">${failed}</div>
      </div>
      <div class="card">
        <div class="card-label">N/A</div>
        <div class="card-value skip">${notApplicable}</div>
      </div>
      <div class="card">
        <div class="card-label">Pass Rate</div>
        <div class="card-value info">${passRate}%</div>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source URL</th>
            <th>Component</th>
            <th>Button Text</th>
            <th>Button Present</th>
            <th>Target URL</th>
            <th>Result</th>
            <th>Navigation Type</th>
            <th>New Tab</th>
            <th>API Status</th>
            <th>API Final URL</th>
            <th>API Response (ms)</th>
            <th>API Details</th>
            <th>Genuine Issue</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
  `;

  fs.writeFileSync(outputPath, html);
}

// ------------------------------------------------------------------
// MAIN ENTRY POINT
// ------------------------------------------------------------------

function resolveInputArg() {
  const args = process.argv.slice(2);
  let csvArg = 'urls.csv';
  let urlArg = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node Quote_validator.js [input.csv]');
      console.log('       node Quote_validator.js --file urls.csv');
      console.log('       node Quote_validator.js -f urls.csv');
      console.log('       node Quote_validator.js --url https://example.com/');
      console.log('If no CSV path is provided, the script will look for urls.csv in the current folder.');
      process.exit(0);
    }

    if (arg === '--url') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        console.error('Missing URL after --url.');
        process.exit(1);
      }
      urlArg = nextArg;
      i += 1;
      continue;
    }

    if (arg.startsWith('--url=')) {
      urlArg = arg.slice('--url='.length);
      continue;
    }

    if (arg === '--file' || arg === '-f' || arg === '--input') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        console.error('Missing CSV file path after --file.');
        console.error('Usage: node Quote_validator.js [input.csv]');
        console.error('       node Quote_validator.js --file urls.csv');
        process.exit(1);
      }
      csvArg = nextArg;
      i += 1;
      continue;
    }

    if (arg.startsWith('--file=')) {
      csvArg = arg.split('=')[1];
      continue;
    }

    if (arg.startsWith('--input=')) {
      csvArg = arg.split('=')[1];
      continue;
    }

    if (!arg.startsWith('-')) {
      csvArg = arg;
    }
  }

  return { csvArg, urlArg };
}

async function main() {
  const inputArg = resolveInputArg();
  if (inputArg.urlArg) {
    console.log('[MAIN] Direct URL resolved to:', inputArg.urlArg);
  }

  const csvArg = inputArg.urlArg || inputArg.csvArg;
  const csvPath = path.isAbsolute(csvArg) ? csvArg : path.resolve(process.cwd(), csvArg);

  if (!inputArg.urlArg && !fs.existsSync(csvPath)) {
    console.error(`CSV file not found: ${csvPath}`);
    console.error('Usage: node Quote_validator.js [input.csv]');
    console.error('       node Quote_validator.js --file urls.csv');
    console.error('If no CSV path is provided, the script will look for urls.csv in the current folder.');
    process.exit(1);
  }

  console.log('');
  console.log('========================================');
  console.log('BANNER VALIDATION EXECUTION STARTED');
  console.log('========================================');
  console.log('[MAIN] CSV path resolved to:', csvPath);

  // Read and parse CSV
  let records;
  if (inputArg.urlArg) {
    records = [{ [FALLBACK_CSV_COLUMN_SOURCE_URL]: inputArg.urlArg }];
    console.log('[MAIN] Direct URL input accepted. Row count:', records.length);
  } else {
    const csvContent = fs.readFileSync(csvPath, 'utf-8');
    console.log('[MAIN] CSV file read successfully. Size:', csvContent.length, 'bytes');
    try {
      records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
      console.log('[MAIN] CSV parsed successfully. Row count:', records.length);
    } catch (e) {
      console.error('Failed to parse CSV:', e.message);
      process.exit(1);
    }
  }

  // Collect all results
  let allResults = [];

  for (const record of records) {
    const sourceUrl = record[CSV_COLUMN_SOURCE_URL] || record[FALLBACK_CSV_COLUMN_SOURCE_URL];
    if (!sourceUrl) {
      console.warn('[MAIN] Skipping row without source_url or url:', record);
      continue;
    }
    const bannerSelector = record[CSV_COLUMN_BANNER_SELECTOR] || null;

    console.log('[MAIN] Processing row for URL:', sourceUrl, '| bannerSelector:', bannerSelector || 'default');
    const results = await validateBannerOnUrl(sourceUrl, bannerSelector);
    console.log('[MAIN] Completed validation for:', sourceUrl, '| results count:', results.length);
    allResults = allResults.concat(results);
  }

  // Generate reports
  const reportDir = path.join(process.cwd(), 'Reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const excelPath = path.join(reportDir, `banner_validation_report_${timestamp}.xlsx`);
  const htmlPath = path.join(reportDir, `banner_validation_report_${timestamp}.html`);

  console.log('');
  console.log('=== REPORT GENERATION START ===');
  console.log('[MAIN] Generating Excel report at:', excelPath);
  await generateExcelReport(allResults, excelPath);
  console.log('[MAIN] Excel report written successfully.');

  console.log('[MAIN] Generating HTML report at:', htmlPath);
  generateHtmlReport(allResults, htmlPath);
  console.log('[MAIN] HTML report written successfully.');

  console.log(`Reports generated in ${reportDir}: ${path.basename(excelPath)} and ${path.basename(htmlPath)}`);
  console.log('========================================');
  console.log('BANNER VALIDATION EXECUTION COMPLETED');
  console.log('========================================');
}

// Run
main().catch(console.error);
