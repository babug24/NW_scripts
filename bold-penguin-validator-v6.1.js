/*
 * Bold Penguin-only E2E Validator (v6.2)
 * Dependencies: npm i playwright csv-parse xlsx
 * First time:  npx playwright install chromium
 *
 * Examples:
 *   node bold-penguin-validator.js --url "https://example.com/page"
 *   node bold-penguin-validator.js --file urls.csv
 *   node bold-penguin-validator.js --file urls.csv --mobile --debug
 *   node bold-penguin-validator.js --file urls.csv --parallel 4
 *   node bold-penguin-validator.js --file urls.csv --all        (desktop + mobile)
 *   node bold-penguin-validator.js --file urls.csv --desktop    (default; last flag wins)
 *
 * Mode flags (mutually exclusive, last one wins unless --all/--both is given):
 *   --desktop   Run desktop only (default)
 *   --mobile    Run mobile (iPhone 12 emulation) only
 *   --all       Run both desktop and mobile sequentially
 *
 * CSV headers supported: URL, url, or Url
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { chromium, devices } = require('playwright');
const XLSX = require('xlsx');

let INPUT_CSV = 'urls.csv';
let SINGLE_URL = null;
let MOBILE_MODE = false;
let DESKTOP_MODE = false;
let HEADED_MODE = false;
let DEBUG_MODE = false;
let PARALLEL_WORKERS = 1;
let RUN_BOTH_MODES = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--file' || arg === '--csv') {
    if (!args[++i]) throw new Error(`${arg} requires a file name`);
    INPUT_CSV = args[i];
  } else if (arg === '--url') {
    if (!args[++i]) throw new Error('--url requires a URL');
    SINGLE_URL = args[i];
  } else if (arg === '--parallel' || arg === '-p') {
    const value = /^\d+$/.test(args[i + 1] || '') ? Number(args[++i]) : 4;
    if (value < 1) throw new Error('--parallel requires a positive number of workers');
    PARALLEL_WORKERS = value;
  } else if (arg === '--desktop') {
    DESKTOP_MODE = true;
    MOBILE_MODE = false;
  } else if (arg === '--mobile' || arg === '-m') {
    MOBILE_MODE = true;
    DESKTOP_MODE = false;
  } else if (arg === '--all' || arg === '--both') {
    RUN_BOTH_MODES = true;
    DESKTOP_MODE = true;
    MOBILE_MODE = true;
  } else if (arg === '--headed' || arg === '-h') HEADED_MODE = true;
  else if (arg === '--debug' || arg === '-d') DEBUG_MODE = true;
  else if (!arg.startsWith('-')) INPUT_CSV = arg;
  else console.warn(`Ignoring unknown option: ${arg}`);
}

const REPORTS_DIR = 'reports';
const SCREENSHOT_DIR = 'screenshots';
const NAV_TIMEOUT = 60000;
const BUTTON_TIMEOUT = 15000;
const CTA_WAIT_TIMEOUT = 10000;
const MAX_RETRIES = 2;
const NETWORK_IDLE_TIMEOUT = 3000;

const SMALL_CTA_SELECTOR = 'ngx-web-small-cta, ngx-nationwide-small-cta, .small-cta-wrapper, .nw-small-cta, .nw-cta-small';
const STICKY_CTA_SELECTOR = 'ngx-web-sticky-cta, ngx-nationwide-sticky-cta, .sticky-cta, .sticky-cta-button-container, .sticky.bolt-background-vibrant-blue, [class*="sticky-cta" i], [class*="sticky"][class*="bolt-background-vibrant-blue"], [data-testid*="sticky" i], [data-name*="sticky" i]';
const BOLD_PENGUIN_DOM_TIMEOUT = 20000;
const DRAWER_SELECTOR = '[class*="drawer" i], [class*="offcanvas" i], .cdk-overlay-pane, [role="dialog"], [aria-modal="true"], .mat-drawer, .nw-drawer, [data-testid*="drawer" i], [data-name*="drawer" i]';
const ZIP_INPUT_SELECTOR = 'input[name*="zip" i], input[id*="zip" i], input[name*="postal" i], input[id*="postal" i], input[placeholder*="zip" i], input[aria-label*="zip" i], input[placeholder*="postal" i], input[aria-label*="postal" i]';
const ZIP_ERROR_EMPTY_MESSAGE = 'Enter your 5 or 9 digit ZIP Code.';
const ZIP_ERROR_INVALID_MESSAGE = 'Unable to find a valid state for the given Postal Code. Please try again using a 5 digit Postal Code.';
const VALID_TEST_ZIP = '10001';
const INVALID_TEST_ZIP = '00000';
const APPLICATION_ID_PATTERN = /application\s*id\s*[:#-]?\s*([A-Z0-9]{2,}(?:\s*-\s*[A-Z0-9]{2,})+|[A-Z0-9]{6,})/i;
const APPLICATION_ID_TIMEOUT = 15000;
const BOLD_PENGUIN_EXPECTED_HOST = 'nationwidecommercial.boldpenguin.com';

// All logging goes through this helper so timestamps and indentation stay consistent.
// indent: 0 = top-level, 1 = per-page, 2 = per-CTA.
function logStep(message, indent = 0) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${'  '.repeat(indent)}[${ts}] ${message}`);
}

function isPageClosed(page) {
  return !page || page.isClosed();
}

function normalizeUrlForComparison(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return String(value || '').split('#')[0];
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeCsv(value = '') {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sanitizeReportColumnName(value = '') {
  return String(value || '')
    .replace(/\s*[|/]\s*/g, '_')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'Component';
}

async function handleOverlays(page) {
  const selectors = [
    '#truste-consent-button',
    '#onetrust-accept-btn-handler',
    '#truste-consent-content button[aria-label*="close" i]',
    '#onetrust-banner-sdk button[aria-label*="close" i]',
    '[role="dialog"] .modal-close',
    '[role="dialog"] [data-dismiss="modal"]'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

async function waitForSpinnersToDisappear(page, timeoutMs = 30000) {
  const start = Date.now();
  let clearCycles = 0;

  while (Date.now() - start < timeoutMs) {
    const blockers = await page.evaluate(() => {
      const isVisible = node => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      const collectAllElements = (root, out = []) => {
        for (const el of root.querySelectorAll('*')) {
          out.push(el);
          if (el.shadowRoot) collectAllElements(el.shadowRoot, out);
        }
        return out;
      };
      const allElements = collectAllElements(document);

      const blockerSelector = [
        '[aria-busy="true"]', '[role="progressbar"]',
        '.page-loader', '.loading-spinner', '.loading-wheel', '.nw-spinner', '.bolt-spinner',
        '[class*="spinner" i]', '[class*="loading" i]', '[class*="loader" i]',
        '[id*="spinner" i]', '[id*="loading" i]', '[id*="loader" i]'
      ].join(',');
      const nodes = allElements.filter(node => node.matches?.(blockerSelector));

      const overlaySelector = '[role="dialog"], [aria-modal="true"], .modal, [class*="overlay" i]';
      const waitModal = allElements
        .filter(node => node.matches?.(overlaySelector))
        .some(node => isVisible(node) && /please\s+wait|loading/i.test(node.innerText || node.textContent || ''));

      const BLOCKER_TOKEN = /\b(spinner|loading|loader)\b/;

      const visibleBlockers = nodes.filter(node => {
        if (!isVisible(node)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const className = typeof node.className === 'string' ? node.className : (node.getAttribute?.('class') || '');
        const classAndId = `${className} ${node.id || ''}`.toLowerCase();
        return style.position === 'fixed' || style.position === 'absolute' ||
          rect.width >= 40 || rect.height >= 40 ||
          BLOCKER_TOKEN.test(classAndId);
      });
      return { count: visibleBlockers.length, waitModal };
    }).catch(() => ({ count: 0, waitModal: false }));

    if (blockers.count === 0 && !blockers.waitModal) {
      clearCycles++;
      if (clearCycles >= 3) return { success: true };
    } else {
      clearCycles = 0;
    }
    await page.waitForTimeout(500);
  }
  return { success: false, reason: `Page still has a visible loading blocker after ${timeoutMs}ms` };
}

async function waitForPageToSettle(page, timeout = NAV_TIMEOUT) {
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout, 30000) }).catch(() => {});
  await page.waitForLoadState('load', { timeout: Math.min(timeout, 30000) }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT }).catch(() => {});
  const spinnerState = await waitForSpinnersToDisappear(page, Math.min(timeout, 30000));
  return spinnerState.success ? { success: true } : spinnerState;
}

async function navigateWithRetry(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await waitForPageToSettle(page);
      return { statusCode: response?.status() || 200, finalUrl: page.url() };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await page.waitForTimeout(2000);
    }
  }
  throw lastError;
}

async function getPageErrorReason(page, finalUrl, title) {
  if (!finalUrl) return 'No final URL';
  const titleLower = String(title || '').toLowerCase();
  const titleErrors = ['404', 'page not found', "we can't find that page", 'access denied', 'internal server error', 'service unavailable'];
  if (titleErrors.some(value => titleLower.includes(value))) return `Error title: ${title}`;

  const body = await page.locator('body').innerText().catch(() => '');
  const bodyLower = body.toLowerCase();
  const bodyErrors = [
    "we can't find that page", 'this page can\'t be found',
    '404 not found', '500 internal server error', '503 service unavailable',
    'application unavailable', 'temporarily unable to retrieve your quote'
  ];
  const found = bodyErrors.find(value => bodyLower.includes(value));
  return found ? `Error content: ${found}` : null;
}

async function extractApplicationId(page, timeoutMs = APPLICATION_ID_TIMEOUT) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 500) {
    const body = await page.locator('body').innerText().catch(() => '');
    const match = body.match(APPLICATION_ID_PATTERN);
    if (match) return match[1].replace(/\s+/g, '');
    if (isPageClosed(page)) break;
    await page.waitForTimeout(500);
  }
  return '';
}

async function getVisibleDrawer(page) {
  const candidates = page.locator(DRAWER_SELECTOR);
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = candidates.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function captureVisibleInteractiveFingerprint(page) {
  return page.evaluate(() => {
    const isVisible = node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    return [...document.querySelectorAll('a[href], button, [role="button"]')]
      .filter(isVisible)
      .map(node => `${node.tagName}|${(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()}|${node.getAttribute('href') || ''}`);
  }).catch(() => []);
}

async function findRevealedPanel(page, beforeList) {
  const marked = await page.evaluate((beforeArr) => {
    const isVisible = node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const fingerprint = node => `${node.tagName}|${(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim()}|${node.getAttribute('href') || ''}`;
    const beforeSet = new Set(beforeArr);
    const newNodes = [...document.querySelectorAll('a[href], button, [role="button"]')]
      .filter(node => isVisible(node) && !beforeSet.has(fingerprint(node)));
    if (!newNodes.length) return false;
    let ancestor = newNodes[0];
    for (const node of newNodes.slice(1)) {
      while (ancestor && !ancestor.contains(node)) ancestor = ancestor.parentElement;
    }
    if (!ancestor || ancestor === document.body || ancestor === document.documentElement) return false;
    ancestor.setAttribute('data-cta-validator-panel', 'true');
    return true;
  }, beforeList).catch(() => false);
  return marked ? page.locator('[data-cta-validator-panel="true"]').first() : null;
}

async function findControlledPanel(page, locator) {
  const controls = await locator.getAttribute('aria-controls').catch(() => null);
  if (!controls) return null;
  for (const id of controls.split(/\s+/).filter(Boolean)) {
    const panel = page.locator(`[id="${id.replace(/"/g, '\\"')}"]`).first();
    if (!(await panel.isVisible().catch(() => false))) continue;
    const interactive = await panel.locator('a[href], button, [role="button"], input').count().catch(() => 0);
    if (interactive) return panel;
  }
  return null;
}

async function resolveOpenPanel(page, locator, beforeFingerprint) {
  const drawer = await getVisibleDrawer(page).catch(() => null);
  if (drawer) return drawer;
  const controlled = await findControlledPanel(page, locator).catch(() => null);
  if (controlled) return controlled;
  if (!beforeFingerprint) return null;
  return findRevealedPanel(page, beforeFingerprint).catch(() => null);
}

async function findZipWidget(drawerLocator) {
  const zipInput = drawerLocator.locator(ZIP_INPUT_SELECTOR).first();
  if (!(await zipInput.isVisible().catch(() => false))) return null;
  const form = drawerLocator.locator('form').filter({ has: drawerLocator.locator(ZIP_INPUT_SELECTOR) }).first();
  const formSubmit = form.locator('button[type="submit"], input[type="submit"]').first();
  const submitButton = (await formSubmit.isVisible().catch(() => false))
    ? formSubmit
    : drawerLocator.locator('button, [role="button"]').first();
  return { zipInput, submitButton };
}

async function collectDrawerDescriptors(drawerLocator) {
  return drawerLocator.evaluate((drawerNode, zipSelector) => {
    const isVisible = node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const zipInput = drawerNode.querySelector(zipSelector);
    const zipForm = zipInput ? zipInput.closest('form') : null;
    const elements = [...drawerNode.querySelectorAll('a[href], button, [role="button"]')].filter(isVisible);
    return elements.map((node, index) => ({
      index,
      tag: node.tagName.toLowerCase(),
      text: (node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
      href: node.getAttribute('href') || '',
      ariaLabel: node.getAttribute('aria-label') || '',
      isZipSubmit: !!(zipForm && node.closest('form') === zipForm)
    }));
  }, ZIP_INPUT_SELECTOR).catch(() => []);
}

async function openStickyDrawer(page, item, sourceUrl) {
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
  await waitForPageToSettle(page).catch(() => {});
  await handleOverlays(page);
  await revealStickyCta(page);
  await item.locator.scrollIntoViewIfNeeded().catch(() => {});
  await item.locator.waitFor({ state: 'visible', timeout: BUTTON_TIMEOUT }).catch(() => {});
  const beforeFingerprint = await captureVisibleInteractiveFingerprint(page);
  try {
    await item.locator.click({ timeout: BUTTON_TIMEOUT });
  } catch {
    await item.locator.click({ force: true, timeout: BUTTON_TIMEOUT }).catch(() => {});
  }
  for (let elapsed = 0; elapsed < 4000; elapsed += 250) {
    const drawer = await getVisibleDrawer(page).catch(() => null) ||
      await findControlledPanel(page, item.locator).catch(() => null);
    if (drawer) return drawer;
    await page.waitForTimeout(250);
  }
  return resolveOpenPanel(page, item.locator, beforeFingerprint);
}

async function runZipScenario(page, item, sourceUrl, zip, expectation) {
  const label = expectation === 'valid' ? ('ZIP valid (' + zip + ') redirects to Quote page')
    : expectation === 'empty' ? 'ZIP empty shows required error'
    : ('ZIP invalid (' + zip + ') shows invalid error');
  const rowText = 'StickyCTA Drawer: ' + label;
  const drawerLocator = await openStickyDrawer(page, item, sourceUrl);
  if (!drawerLocator) {
    return { text: rowText, href: '', finalUrl: '', success: false, skipped: false, backSuccess: false, error: 'Drawer did not reopen for ZIP scenario', remarks: '', backUrl: '' };
  }
  const widget = await findZipWidget(drawerLocator);
  if (!widget) {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    await waitForPageToSettle(page).catch(() => {});
    return { text: rowText, href: '', finalUrl: '', success: false, skipped: true, backSuccess: true, error: '', remarks: 'No ZIP input found in drawer', backUrl: '' };
  }

  await widget.zipInput.fill('').catch(() => {});
  if (zip) await widget.zipInput.fill(zip).catch(() => {});
  await widget.submitButton.click({ timeout: BUTTON_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(1000);

  if (expectation === 'valid') {
    let navigated = false;
    for (let elapsed = 0; elapsed < CTA_WAIT_TIMEOUT; elapsed += 250) {
      if (normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(sourceUrl)) { navigated = true; break; }
      await page.waitForTimeout(250);
    }
    const finalUrl = page.url();
    if (navigated) {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await waitForPageToSettle(page).catch(() => {});
    }
    return {
      text: rowText, href: '', finalUrl: navigated ? finalUrl : '', success: navigated, skipped: false, backSuccess: true,
      error: navigated ? '' : ('Expected redirect to Quote page after entering valid ZIP ' + zip),
      remarks: navigated ? ('Redirected to ' + finalUrl) : 'No redirect detected after valid ZIP submission', backUrl: sourceUrl
    };
  }

  const expectedMessage = expectation === 'empty' ? ZIP_ERROR_EMPTY_MESSAGE : ZIP_ERROR_INVALID_MESSAGE;
  const bodyText = await drawerLocator.innerText().catch(() => '');
  const success = bodyText.toLowerCase().includes(expectedMessage.toLowerCase());
  await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
  await waitForPageToSettle(page).catch(() => {});
  return {
    text: rowText, href: '', finalUrl: '', success, skipped: false, backSuccess: true,
    error: success ? '' : ('Expected error message "' + expectedMessage + '" not found'),
    remarks: success ? ('Error message displayed: "' + expectedMessage + '"') : ('Drawer text: ' + bodyText.replace(/\s+/g, ' ').trim().slice(0, 200)),
    backUrl: sourceUrl
  };
}

async function resolveDrawerTarget(drawerLocator, descriptor) {
  const candidates = drawerLocator.locator('a[href], button, [role="button"]');
  const count = await candidates.count().catch(() => 0);

  if (descriptor.href) {
    const escaped = descriptor.href.replace(/"/g, '\\"');
    const byHref = drawerLocator.locator(`a[href="${escaped}"], [data-href="${escaped}"]`).first();
    if (await byHref.count().catch(() => 0) > 0 && await byHref.isVisible().catch(() => false)) {
      return { target: byHref, matchedBy: 'href' };
    }
  }
  if (descriptor.ariaLabel) {
    const escaped = descriptor.ariaLabel.replace(/"/g, '\\"');
    const byLabel = drawerLocator.locator(`[aria-label="${escaped}"]`).first();
    if (await byLabel.count().catch(() => 0) > 0 && await byLabel.isVisible().catch(() => false)) {
      return { target: byLabel, matchedBy: 'aria-label' };
    }
  }
  if (descriptor.index < count) {
    return { target: candidates.nth(descriptor.index), matchedBy: 'index' };
  }
  return { target: null, matchedBy: 'none' };
}

async function validateDrawerContents(page, item, sourceUrl) {
  const rows = [];
  const initialDrawer = await openStickyDrawer(page, item, sourceUrl);
  if (!initialDrawer) {
    logStep('Drawer could not be reopened to enumerate its links', 2);
    return rows;
  }

  const zipWidget = await findZipWidget(initialDrawer);
  const descriptors = await collectDrawerDescriptors(initialDrawer);
  logStep(`Drawer links/buttons to validate: ${descriptors.filter(d => !d.isZipSubmit).length}`, 2);

  for (const descriptor of descriptors) {
    if (descriptor.isZipSubmit) continue;
    const rowText = 'StickyCTA Drawer: ' + (descriptor.text || descriptor.tag);
    const drawerLocator = await openStickyDrawer(page, item, sourceUrl);
    if (!drawerLocator) {
      rows.push({ text: rowText, href: descriptor.href, finalUrl: '', success: false, skipped: false, backSuccess: false, error: 'Drawer did not reopen', remarks: '', backUrl: '' });
      continue;
    }
    const { target, matchedBy } = await resolveDrawerTarget(drawerLocator, descriptor);
    if (!target) {
      rows.push({
        text: rowText, href: descriptor.href, finalUrl: '',
        success: false, skipped: false, backSuccess: false,
        error: 'Drawer target could not be resolved after reopen',
        remarks: `Descriptor index=${descriptor.index} href=${descriptor.href || '(none)'} not found`,
        backUrl: ''
      });
      continue;
    }
    const validation = await validateButtonClick(page, target, rowText, sourceUrl);
    rows.push({
      text: rowText,
      href: validation.href || descriptor.href,
      finalUrl: validation.finalUrl || '',
      success: validation.success,
      skipped: validation.skipped || false,
      backSuccess: validation.backSuccess,
      error: validation.error || validation.backError || '',
      remarks: [validation.remarks, `target matched by ${matchedBy}`].filter(Boolean).join(' | '),
      backUrl: validation.backUrl || ''
    });
  }

  if (zipWidget) {
    rows.push(await runZipScenario(page, item, sourceUrl, VALID_TEST_ZIP, 'valid'));
    rows.push(await runZipScenario(page, item, sourceUrl, '', 'empty'));
    rows.push(await runZipScenario(page, item, sourceUrl, INVALID_TEST_ZIP, 'invalid'));
  }

  return rows;
}

async function getButtonLabel(locator, fallback) {
  return locator.evaluate(node => {
    return (node.innerText || node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '')
      .replace(/\s+/g, ' ').trim();
  }).catch(() => fallback) || fallback;
}

async function validateButtonClick(page, locator, description, returnToUrl) {
  const sourceUrl = page.url();
  let href = '';
  let openedPage = null;
  let popupError = null;
  const observedMainFrameUrls = [sourceUrl];

  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.waitFor({ state: 'visible', timeout: BUTTON_TIMEOUT });
    await handleOverlays(page);

    href = await locator.getAttribute('href').catch(() => '');
    if (href && !/^(https?:|tel:|mailto:)/i.test(href)) href = new URL(href, sourceUrl).href;
    if (/^(tel:|mailto:)/i.test(href)) {
      return { success: true, skipped: true, href, finalUrl: href, title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `Skipped external ${href.split(':')[0]} link` };
    }

    logStep(`Testing ${description}`, 2);
    logStep(`Source: ${sourceUrl}`, 2);
    logStep(`Href: ${href || '(JavaScript/router button)'}`, 2);

    const isStickyCta = description.startsWith('StickyCTA') && !description.startsWith('StickyCTA Drawer');
    const captureApplicationId = description.startsWith('Bold Penguin');
    const beforeFingerprint = isStickyCta ? await captureVisibleInteractiveFingerprint(page) : null;
    const expandedBefore = await locator.getAttribute('aria-expanded').catch(() => null);

    const onPage = candidate => {
      if (candidate !== page && !openedPage) openedPage = candidate;
    };
    page.context().on('page', onPage);
    const onMainFrameNavigation = frame => {
      if (frame === page.mainFrame() && !observedMainFrameUrls.includes(frame.url())) {
        observedMainFrameUrls.push(frame.url());
      }
    };
    page.on('framenavigated', onMainFrameNavigation);

    try {
      await locator.click({ timeout: BUTTON_TIMEOUT });
    } catch (normalClickError) {
      logStep(`Normal click failed: ${normalClickError.message}; trying force click`, 2);
      await locator.click({ force: true, timeout: BUTTON_TIMEOUT });
    }

    let navigated = false;
    let drawerLocator = null;
    const redirectTimeout = description.startsWith('Bold Penguin') ? 30000 : CTA_WAIT_TIMEOUT;
    for (let elapsed = 0; elapsed < redirectTimeout; elapsed += 250) {
      if (normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(sourceUrl)) {
        navigated = true;
      }
      if (isStickyCta && !navigated && !openedPage && !drawerLocator) {
        drawerLocator = await getVisibleDrawer(page).catch(() => null) ||
          await findControlledPanel(page, locator).catch(() => null);
      }
      const settleAfterNavigation = captureApplicationId ? 6000 : 2000;
      if (navigated && openedPage) break;
      if (navigated && elapsed >= settleAfterNavigation) break;
      if (openedPage && elapsed >= 2000) break;
      if (drawerLocator && elapsed >= 1000) break;
      await page.waitForTimeout(250);
    }
    page.context().off('page', onPage);
    page.off('framenavigated', onMainFrameNavigation);

    if (!drawerLocator && !navigated && !openedPage && isStickyCta) {
      drawerLocator = await findRevealedPanel(page, beforeFingerprint).catch(() => null);
    }

    if (drawerLocator && !navigated && !openedPage) {
      logStep(`Drawer opened by ${description}`, 2);
      return { success: true, isDrawer: true, href, finalUrl: '', title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: 'Drawer opened after click' };
    }

    if (!navigated && !openedPage && expandedBefore !== null) {
      const expandedAfter = await locator.getAttribute('aria-expanded').catch(() => null);
      if (expandedAfter !== null && expandedAfter !== expandedBefore) {
        if (expandedAfter === 'true') {
          logStep(`Panel expanded by ${description}; validating its contents`, 2);
          return { success: true, isDrawer: true, href, finalUrl: '', title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `Panel expanded after click (aria-expanded ${expandedBefore} -> ${expandedAfter})` };
        }
        logStep(`In-page control toggled by ${description} (aria-expanded ${expandedBefore} -> ${expandedAfter})`, 2);
        return { success: true, skipped: true, href, finalUrl: '', title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `In-page control: aria-expanded ${expandedBefore} -> ${expandedAfter}; no navigation expected` };
      }
    }

    if (openedPage && !navigated) {
      await openedPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(error => { popupError = error; });
      await waitForPageToSettle(openedPage);
      const finalUrl = openedPage.url();
      const title = await openedPage.title().catch(() => '');
      const pageError = await getPageErrorReason(openedPage, finalUrl, title);
      const applicationId = captureApplicationId ? await extractApplicationId(openedPage) : '';
      await openedPage.close().catch(() => {});
      if (popupError) throw popupError;
      if (pageError) throw new Error(pageError);
      logStep(`Popup destination validated: ${finalUrl}`, 2);
      if (applicationId) logStep(`Application ID captured: ${applicationId}`, 2);
      return { success: true, href, finalUrl, title, applicationId, newTabUrl: finalUrl, newTabStatus: `New tab opened and validated: ${finalUrl}`, backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `New-window destination validated: ${finalUrl}${applicationId ? ` | Application ID: ${applicationId}` : ''}` };
    }

    if (!navigated) {
      return {
        success: false, href, finalUrl: '', title: '', backSuccess: false,
        backError: 'No navigation or new tab detected after click',
        remarks: `No external destination detected within ${redirectTimeout}ms | Observed main-frame URLs: ${observedMainFrameUrls.join(' -> ')}`,
        error: `CTA did not navigate from ${sourceUrl}${href ? ` (expected href: ${href})` : ''}`
      };
    }

    let popupObservation = '';
    let newTabStatus = '';
    let popupApplicationId = '';
    if (openedPage) {
      await openedPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      await waitForPageToSettle(openedPage).catch(() => {});
      popupObservation = openedPage.url();
      const popupTitle = await openedPage.title().catch(() => '');
      const popupPageError = await getPageErrorReason(openedPage, popupObservation, popupTitle).catch(() => null);
      if (captureApplicationId) popupApplicationId = await extractApplicationId(openedPage).catch(() => '');
      const hostMatches = (() => {
        try {
          const host = new URL(popupObservation).hostname.toLowerCase();
          return host === BOLD_PENGUIN_EXPECTED_HOST || host.endsWith('.' + BOLD_PENGUIN_EXPECTED_HOST);
        } catch { return false; }
      })();
      newTabStatus = popupPageError
        ? `New tab opened with an error page: ${popupPageError}`
        : hostMatches
          ? `New tab opened and validated on ${BOLD_PENGUIN_EXPECTED_HOST}`
          : `New tab opened on an unexpected host (expected ${BOLD_PENGUIN_EXPECTED_HOST})`;
      logStep(`${newTabStatus}: ${popupObservation}`, 2);
      await openedPage.close().catch(() => {});
    }

    await waitForPageToSettle(page);
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const pageError = await getPageErrorReason(page, finalUrl, title);
    if (pageError) throw new Error(pageError);
    logStep(`Destination validated: ${finalUrl}`, 2);
    const applicationId = (captureApplicationId ? await extractApplicationId(page) : '') || popupApplicationId;
    if (applicationId) logStep(`Application ID captured: ${applicationId}`, 2);

    logStep('Validating browser back navigation', 2);
    let backSuccess = false;
    let backError = '';
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const settleAfterBack = await waitForPageToSettle(page, NAV_TIMEOUT);
      const urlMatches = normalizeUrlForComparison(page.url()) === normalizeUrlForComparison(returnToUrl);
      backSuccess = urlMatches && settleAfterBack.success;

      if (!urlMatches) {
        backError = `Browser back returned ${page.url()} instead of ${returnToUrl}`;
      } else if (!settleAfterBack.success) {
        backError = `Browser back reached the expected URL but the page did not finish rendering: ${settleAfterBack.reason}`;
      }
    } catch (error) {
      backError = `Browser back failed: ${error.message}`;
    }

    if (!backSuccess) {
      await page.goto(returnToUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await waitForPageToSettle(page).catch(() => {});
    }

    return { success: backSuccess, href, finalUrl, title, applicationId, newTabUrl: popupObservation, newTabStatus, backSuccess, backError, backUrl: page.url(), remarks: `Observed main-frame URLs: ${observedMainFrameUrls.join(' -> ')} | Destination: ${finalUrl}${applicationId ? ` | Application ID: ${applicationId}` : ''}${popupObservation ? ` | Same-window redirect to ${finalUrl} AND new tab to ${popupObservation} | ${newTabStatus}` : ''} | Back-navigation URL: ${page.url()}${page.url().endsWith('#') ? ' | Application added trailing # fragment on back navigation' : ''}`, error: backSuccess ? '' : backError };
  } catch (error) {
    if (!isPageClosed(page) && normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(returnToUrl)) {
      await page.goto(returnToUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    }
    return { success: false, href, finalUrl: '', title: '', backSuccess: false, backError: error.message, backUrl: !isPageClosed(page) ? page.url() : '', remarks: `Validation exception: ${error.message}`, error: error.message };
  }
}

// ============================================================================
// Dynamic Bold Penguin detection
// ----------------------------------------------------------------------------
// Scans the entire document (including open shadow roots) for anything that
// looks like a Bold Penguin / "start your quote" CTA, regardless of which
// component (or none) contains it. Every surviving match is tagged with
// data-bold-penguin-validator-match="<i>" and annotated with the component
// that encloses it (StickyCTA / SmallCTA / Page).
// ============================================================================
async function scanForBoldPenguinMatches(page) {
  return page.evaluate((selectors) => {
    const { stickySelector, smallSelector } = selectors;

    const readText = node => String(
      node?.innerText || node?.textContent ||
      node?.getAttribute?.('aria-label') || node?.getAttribute?.('title') ||
      node?.getAttribute?.('value') || ''
    ).replace(/\s+/g, ' ').trim();

    const isVisible = node => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };

    const readClass = el => {
      if (!el) return '';
      if (typeof el.className === 'string') return el.className;
      return el.getAttribute?.('class') || '';
    };

    // Walk up the ancestor chain (crossing open shadow boundaries) and label the
    // enclosing CTA component. Reuses the existing component selectors so no new
    // component-specific logic is introduced; falls back to a generic class-name
    // heuristic for wrappers that are not covered by the selectors.
    const classifyComponent = (startNode) => {
      let current = startNode;
      let steps = 0;
      while (current && steps < 50) {
        try {
          if (smallSelector && current.matches?.(smallSelector)) return 'SmallCTA';
          if (stickySelector && current.matches?.(stickySelector)) return 'StickyCTA';
        } catch { /* invalid selector for this element type */ }

        const marker = [
          current.tagName || '',
          readClass(current),
          current.id || '',
          current.getAttribute?.('data-testid') || '',
          current.getAttribute?.('data-name') || '',
          current.getAttribute?.('aria-label') || ''
        ].join(' ').toLowerCase();

        if (/small[- _]?cta/.test(marker)) return 'SmallCTA';
        if (/\bsticky\b/.test(marker)) return 'StickyCTA';

        if (current.parentElement) {
          current = current.parentElement;
        } else {
          const root = current.getRootNode?.();
          current = root && root.host ? root.host : null;
        }
        steps++;
      }
      return 'Page';
    };

    const collectAll = (root, out = []) => {
      if (!root || !root.querySelectorAll) return out;
      for (const el of root.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) collectAll(el.shadowRoot, out);
      }
      return out;
    };
    const allElements = collectAll(document);

    for (const el of allElements) el.removeAttribute?.('data-bold-penguin-validator-match');

    const BP_MARKER = /bold[- _]?penguin|boldpenguin/i;
    const QUOTE_TEXT = /start\s+your\s+quote|get\s+a\s+quote|get\s+quote|request\s+(a\s+)?quote|get\s+started/i;
    const CLICKABLE = 'a, button, [role="button"], [onclick], [data-url], [data-href], [routerLink]';

    const describe = node => {
      let shadowHost = null;
      try { shadowHost = node.getRootNode?.()?.host || null; } catch { /* ignore */ }
      const attrs = [
        readClass(node), node.id || '',
        node.getAttribute?.('data-testid') || '',
        node.getAttribute?.('data-name') || '',
        node.getAttribute?.('aria-label') || ''
      ].join(' ').toLowerCase();
      const hostAttrs = shadowHost
        ? `${readClass(shadowHost)} ${shadowHost.id || ''}`.toLowerCase()
        : '';
      const text = readText(node).toLowerCase();
      const hostText = shadowHost ? readText(shadowHost).toLowerCase() : '';
      return { source: `${attrs} ${hostAttrs} ${text} ${hostText}`, text, hostText };
    };

    const seen = new Set();
    const enriched = [];
    for (const node of allElements) {
      if (!node.matches?.(CLICKABLE) || seen.has(node)) continue;
      seen.add(node);
      const { source, text, hostText } = describe(node);
      const isBp = BP_MARKER.test(source);
      const isQuote = QUOTE_TEXT.test(text) || QUOTE_TEXT.test(hostText);
      if (!isBp && !isQuote) continue;
      if (!isVisible(node)) continue;

      let score = 0;
      if (isBp) score += 100;
      if (/quote/.test(source) && /bold/.test(source)) score += 40;
      if (isQuote) score += 35;
      if (node.tagName === 'A' || node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') score += 10;
      if (node.getAttribute('href') || node.onclick || node.getAttribute('data-url') || node.getAttribute('routerLink')) score += 10;

      const rect = node.getBoundingClientRect();
      enriched.push({
        node, score,
        text: readText(node),
        href: node.getAttribute('href') || node.getAttribute('data-url') || node.getAttribute('data-href') || node.getAttribute('routerLink') || '',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        component: classifyComponent(node)
      });
    }

    const leafMatches = enriched.filter(e =>
      !enriched.some(other => other !== e && e.node.contains(other.node))
    );

    const dedup = new Map();
    for (const c of leafMatches) {
      const key = `${c.text.toLowerCase()}|${c.href}`;
      const existing = dedup.get(key);
      if (!existing || c.score > existing.score) dedup.set(key, c);
    }

    const final = [...dedup.values()].sort((a, b) => b.score - a.score);
    final.forEach((c, i) => c.node.setAttribute('data-bold-penguin-validator-match', String(i)));

    return final.map((c, i) => ({
      index: i,
      score: c.score,
      text: c.text,
      href: c.href,
      rect: c.rect,
      component: c.component,
      elementName: (() => {
        const node = c.node;
        const direct = [
          node.getAttribute?.('data-testid'),
          node.getAttribute?.('data-name'),
          node.id,
          node.getAttribute?.('aria-label'),
          (typeof node.className === 'string' ? node.className : node.getAttribute?.('class')),
          node.tagName
        ].find(value => typeof value === 'string' && value.trim());
        const rootHost = node.getRootNode?.()?.host;
        const hostName = rootHost ? [
          rootHost.getAttribute?.('data-testid'),
          rootHost.getAttribute?.('data-name'),
          rootHost.id,
          (typeof rootHost.className === 'string' ? rootHost.className : rootHost.getAttribute?.('class')),
          rootHost.tagName
        ].find(value => typeof value === 'string' && value.trim()) : '';
        return [direct, hostName].filter(Boolean).map(String).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ') || c.component || 'Page';
      })()
    }));
  }, { stickySelector: STICKY_CTA_SELECTOR, smallSelector: SMALL_CTA_SELECTOR }).catch(() => []);
}

// Returns ALL Bold Penguin-like clickables on the page (best-scoring first),
// each annotated with the component that contains it.
async function findBoldPenguinLocators(page) {
  const descriptors = await scanForBoldPenguinMatches(page);
  return descriptors.map(d => ({
    selector: `[data-bold-penguin-validator-match="${d.index}"]`,
    locator: page.locator(`[data-bold-penguin-validator-match="${d.index}"]`).first(),
    text: d.text,
    href: d.href,
    score: d.score,
    rect: d.rect,
    component: d.component || 'Page',
    elementName: d.elementName || d.component || 'Page'
  }));
}

// Backward-compatible single-result shim.
async function findBoldPenguinLocator(page) {
  const all = await findBoldPenguinLocators(page);
  return all.length ? all[0] : null;
}

async function waitForBoldPenguinMarkup(page) {
  await page.locator('a, button, [role="button"]').first()
    .waitFor({ state: 'attached', timeout: BOLD_PENGUIN_DOM_TIMEOUT }).catch(() => {});

  const check = async () => (await scanForBoldPenguinMatches(page)).length > 0;
  const resetScroll = () => page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  if (await check()) return true;

  const height = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  const step = Math.max(500, Math.ceil(height / 20));
  for (let y = 0; y <= height; y += step) {
    await page.evaluate(v => window.scrollTo(0, v), y).catch(() => {});
    await page.waitForTimeout(200);
    if (await check()) {
      await resetScroll();
      await page.waitForTimeout(200);
      return true;
    }
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(750);
  if (await check()) {
    await resetScroll();
    return true;
  }

  await resetScroll();
  return false;
}

async function collectCtasFromContainers(page, selector, category) {
  const output = [];
  const containers = page.locator(selector);
  const containerCount = await containers.count();

  for (let containerIndex = 0; containerIndex < containerCount; containerIndex++) {
    const container = containers.nth(containerIndex);
    await container.scrollIntoViewIfNeeded().catch(() => {});
    await container.locator('a, button, [role="button"]').first()
      .waitFor({ state: 'attached', timeout: CTA_WAIT_TIMEOUT }).catch(() => {});

    const candidates = container.locator(
      'a[href], a.bold-penguin-quote, a.button, a[target="_blank"], button, [role="button"], [onclick], [routerLink], [data-url], [data-href]'
    );
    const count = await candidates.count();

    for (let index = 0; index < count; index++) {
      const locator = candidates.nth(index);
      const data = await locator.evaluate(node => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const readText = element => (element?.innerText || element?.textContent ||
          element?.getAttribute?.('aria-label') || element?.getAttribute?.('title') ||
          element?.getAttribute?.('value') || '').replace(/\s+/g, ' ').trim();
        const shadowHost = node.getRootNode()?.host || null;
        const image = node.querySelector('img[alt], [aria-label]');
        const text = readText(node) || readText(shadowHost) || readText(image) ||
          readText(node.closest?.('[aria-label], [title]')) || '';
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0,
          text,
          href: node.getAttribute('href') || node.getAttribute('data-url') || node.getAttribute('data-href') || node.getAttribute('routerLink') ||
            shadowHost?.getAttribute?.('href') || '',
          target: node.getAttribute('target') || shadowHost?.getAttribute?.('target') || '',
          isWrapper: !!node.querySelector('a[href], button, [role="button"], [onclick], [routerLink], [data-url], [data-href]'),
          receivesPointer: hit === node || node.contains(hit) || hit?.contains(node) || (!!shadowHost && (hit === shadowHost || shadowHost.contains(hit)))
        };
      }).catch(() => null);
      if (!data?.visible) continue;
      if (data.isWrapper) continue;
      const resolvedHref = data.href ? new URL(data.href, page.url()).href : '';
      if (!data.text && (!resolvedHref || /^javascript:|#$/i.test(data.href))) continue;
      output.push({
        locator,
        text: data.text || `${category} ${containerIndex + 1}.${index + 1}`,
        href: resolvedHref,
        target: data.target,
        receivesPointer: data.receivesPointer,
        category
      });
    }
  }
  return output;
}

function deduplicateCtas(items) {
  const grouped = new Map();
  for (const item of items) {
    let key = `${item.category}|${(item.text || '').trim().toLowerCase()}`;
    if (item.href) {
      try {
        const url = new URL(item.href);
        key = `${item.category}|${url.origin}${url.pathname}`.toLowerCase();
      } catch {
        key = `${item.category}|${item.href.split('?')[0]}`.toLowerCase();
      }
    }

    const score = (item.receivesPointer ? 100 : 0) +
      (item.target === '_blank' ? 20 : 0) +
      (item.href ? 5 : 0);
    const current = grouped.get(key);
    if (!current || score > current.score) grouped.set(key, { ...item, score });
  }
  return [...grouped.values()];
}

async function revealStickyCta(page) {
  for (const ratio of [0.4, 0.75, 1]) {
    await page.evaluate(value => window.scrollTo(0, Math.floor(document.body.scrollHeight * value)), ratio);
    await page.waitForTimeout(500);
  }
  await handleOverlays(page);
}

async function validateCtaGroup(page, sourceUrl, items, category) {
  const output = [];
  const uniqueItems = deduplicateCtas(items);
  logStep(`${category} unique buttons to validate: ${uniqueItems.length}`, 2);

  for (const item of uniqueItems) {
    if (normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(sourceUrl)) {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await waitForPageToSettle(page);
      await handleOverlays(page);
    }
    if (category === 'StickyCTA') {
      await revealStickyCta(page);
      await item.locator.scrollIntoViewIfNeeded().catch(() => {});
    }

    const validation = await validateButtonClick(page, item.locator, `${category}: ${item.text}`, sourceUrl);
    output.push({
      text: item.text,
      href: validation.href || item.href,
      finalUrl: validation.finalUrl || '',
      success: validation.success,
      skipped: validation.skipped || false,
      backSuccess: validation.backSuccess,
      error: validation.error || validation.backError || '',
      remarks: validation.remarks || '',
      backUrl: validation.backUrl || ''
    });

    if (category === 'StickyCTA' && validation.isDrawer) {
      const drawerRows = await validateDrawerContents(page, item, sourceUrl);
      output.push(...drawerRows);
    }
  }
  return output;
}

function categorySummary(items) {
  if (!items.length) return { status: 'N/A', urls: '' };
  const testable = items.filter(item => !item.skipped);
  if (!testable.length) return { status: 'N/A', urls: items.map(item => item.href).filter(Boolean).join(' | ') };
  return {
    status: testable.every(item => item.success && item.backSuccess) ? 'PASS' : 'FAIL',
    urls: items.map(item => item.finalUrl || item.href).filter(Boolean).join(' | ')
  };
}

async function validateAllCtas(page, sourceUrl) {
  for (const position of [0.35, 0.7, 1]) {
    await page.evaluate((ratio) => window.scrollTo(0, Math.floor(document.body.scrollHeight * ratio)), position);
    await page.waitForTimeout(750);
  }
  await handleOverlays(page);

  await page.locator(SMALL_CTA_SELECTOR).first()
    .waitFor({ state: 'attached', timeout: 20000 })
    .catch(() => {});

  let sticky = await collectCtasFromContainers(page, STICKY_CTA_SELECTOR, 'StickyCTA');
  let small = await collectCtasFromContainers(page, SMALL_CTA_SELECTOR, 'SmallCTA');

  if (!small.length) {
    await page.waitForTimeout(2000);
    small = await collectCtasFromContainers(page, '.nw-small-cta, .nw-cta-small', 'SmallCTA');
  }

  if (!sticky.length) {
    const fallbackSelector = 'a[href], a.bold-penguin-quote, a.button, a[target="_blank"], button, [role="button"]';
    const candidates = page.locator(fallbackSelector);
    const count = await candidates.count();
    for (let i = 0; i < count; i++) {
      const locator = candidates.nth(i);
      const candidate = await locator.evaluate(node => {
        let current = node;
        for (let level = 0; current && level < 8; level++, current = current.parentElement) {
          const tag = (current.tagName || '').toLowerCase();
          const className = String(current.className || '');
          const id = String(current.id || '');
          const marker = `${tag} ${className} ${id}`.toLowerCase();
          const position = getComputedStyle(current).position;
          if ((marker.includes('sticky') && (marker.includes('cta') || marker.includes('quote'))) ||
              tag.includes('sticky') ||
              ((position === 'fixed' || position === 'sticky') && marker.includes('quote'))) {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
              text: (node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
              href: node.getAttribute('href') || node.getAttribute('data-url') || node.getAttribute('routerLink') || ''
            };
          }
        }
        return null;
      }).catch(() => null);
      if (candidate?.visible) {
        sticky.push({ locator, text: candidate.text || `StickyCTA fallback ${i + 1}`, href: candidate.href ? new URL(candidate.href, page.url()).href : '', category: 'StickyCTA' });
      }
    }
  }

  logStep(`SmallCTA found: ${small.length}; StickyCTA found: ${sticky.length}`, 2);
  if (DEBUG_MODE && !sticky.length) {
    const stickyLike = await page.locator('*').evaluateAll(nodes => nodes
      .filter(node => `${node.tagName} ${node.className || ''} ${node.id || ''}`.toLowerCase().includes('sticky'))
      .slice(0, 20)
      .map(node => ({ tag: node.tagName.toLowerCase(), className: String(node.className || ''), id: node.id || '' }))
    ).catch(() => []);
    logStep(`DEBUG: sticky-like DOM elements: ${JSON.stringify(stickyLike)}`, 2);
  }

  logStep('Phase 2/3: SmallCTA validation', 2);
  const smallDetails = await validateCtaGroup(page, sourceUrl, small, 'SmallCTA');
  logStep(`Phase 2/3 complete: SmallCTA rows validated: ${smallDetails.length}`, 2);
  logStep('Phase 3/3: StickyCTA validation', 2);
  const stickyDetails = await validateCtaGroup(page, sourceUrl, sticky, 'StickyCTA');
  logStep(`Phase 3/3 complete: StickyCTA rows validated: ${stickyDetails.length}`, 2);
  const smallSummary = categorySummary(smallDetails);
  const stickySummary = categorySummary(stickyDetails);
  const details = [...smallDetails.map(item => ({ ...item, isSticky: false })), ...stickyDetails.map(item => ({ ...item, isSticky: true }))];

  return {
    status: [smallSummary.status, stickySummary.status].every(status => status === 'N/A') ? 'N/A' :
      [smallSummary.status, stickySummary.status].includes('FAIL') ? 'FAIL' : 'PASS',
    error: details.filter(item => !item.success && !item.skipped).map(item => `${item.text}: ${item.error}`).join('; '),
    details,
    buttonsFound: details.length,
    buttonsTested: details.length,
    passed: details.filter(item => item.success && !item.skipped).length,
    failed: details.filter(item => !item.success && !item.skipped).length,
    skipped: details.filter(item => item.skipped).length,
    smallCtaPresent: small.length > 0 ? 'Yes' : 'No',
    smallCtaStatus: smallSummary.status,
    smallCtaUrls: smallSummary.urls,
    smallCtaRedirectTargets: smallDetails
      .map(item => item.finalUrl)
      .filter(Boolean)
      .join(' | '),
    smallCtaFailureReasons: smallDetails
      .filter(item => !item.success && !item.skipped)
      .map(item => `${item.text}: ${item.error}`)
      .join(' | '),
    stickyCtaPresent: sticky.length > 0 ? 'Yes' : 'No',
    stickyCtaStatus: stickySummary.status,
    stickyCtaUrls: stickySummary.urls,
    stickyCtaRedirectTargets: stickyDetails
      .map(item => item.finalUrl)
      .filter(Boolean)
      .join(' | '),
    stickyCtaFailureReasons: stickyDetails
      .filter(item => !item.success && !item.skipped)
      .map(item => `${item.text}: ${item.error}`)
      .join(' | '),
    remarks: [...stickyDetails, ...smallDetails]
      .map(item => `${item.text}: ${item.remarks}`)
      .filter(Boolean)
      .join(' | ')
  };
}

async function validateUrl(context, inputUrl, index) {
  let page = await context.newPage();
  const result = {
    url: inputUrl, status: 'FAIL',
    boldPenguinDom: 'No', boldPenguinCount: 0, boldPenguinComponents: '', boldPenguinElementName: '', boldPenguinMatchDetails: '', componentResults: {},
    mainStatus: 'N/A', mainError: '', mainFinalUrl: '', mainApiUrl: '',
    mainApplicationId: '', mainNewTabUrl: '', mainNewTabStatus: '',
    mainBackNav: 'N/A', mainBackError: '', mainButtonName: '',
    ctaStatus: 'N/A', ctaError: '',
    smallCtaPresent: 'No', smallCtaStatus: 'N/A', smallCtaUrls: '',
    smallCtaRedirectTargets: '', smallCtaFailureReasons: '',
    stickyCtaPresent: 'No', stickyCtaStatus: 'N/A', stickyCtaUrls: '',
    stickyCtaRedirectTargets: '', stickyCtaFailureReasons: '',
    pageError: '', error: '', remarks: '', screenshot: ''
  };
  try {
    logStep(`Opening page: ${inputUrl}`, 1);
    const nav = await navigateWithRetry(page, inputUrl);
    await handleOverlays(page);
    const sourceUrl = page.url();
    logStep(`Page loaded: ${sourceUrl} | status=${nav.statusCode}`, 1);

    if (nav.statusCode >= 400) throw new Error(`HTTP ${nav.statusCode}`);
    const sourceError = await getPageErrorReason(page, sourceUrl, await page.title().catch(() => ''));
    if (sourceError) throw new Error(sourceError);

    logStep('Checking for Bold Penguin CTA on page...', 1);
    const boldPenguinPresent = await waitForBoldPenguinMarkup(page);
    result.boldPenguinDom = boldPenguinPresent ? 'Yes' : 'No';
    logStep(`Bold Penguin presence check: ${boldPenguinPresent ? 'found' : 'not found'}`, 1);

    let bpItems = await findBoldPenguinLocators(page);
    result.boldPenguinCount = bpItems.length;
    logStep(`Bold Penguin candidates detected: ${bpItems.length}`, 1);
    if (bpItems.length) {
      const summary = bpItems.map(i => `${i.component || 'Page'}:${i.elementName || i.text || '(unlabeled)'}`).join(' | ');
      logStep(`Bold Penguin component attribution: ${summary}`, 1);
    }

    if (!bpItems.length && boldPenguinPresent) {
      logStep('Bold Penguin markup detected but no clickable quote anchor matched', 1);
    }

    if (bpItems.length) {
      logStep(`Phase 1/3: Bold Penguin validation (${bpItems.length} candidate${bpItems.length > 1 ? 's' : ''} found)`, 1);
      const bpResults = [];

      for (let i = 0; i < bpItems.length; i++) {
        if (normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(sourceUrl)) {
          await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
          await waitForPageToSettle(page).catch(() => {});
          await handleOverlays(page);
        }

        bpItems = await findBoldPenguinLocators(page);
        if (i >= bpItems.length) {
          logStep(`Bold Penguin candidate ${i + 1} no longer present after re-scan`, 1);
          bpResults.push({
            label: `Bold Penguin #${i + 1}`,
            buttonLabel: `Bold Penguin #${i + 1}`,
            component: 'Page',
            success: false, backSuccess: false,
            error: 'Bold Penguin candidate disappeared after page reload',
            remarks: '', href: '', finalUrl: '', applicationId: '',
            newTabUrl: '', newTabStatus: '', backError: ''
          });
          continue;
        }

        const item = bpItems[i];
        const buttonLabel = await getButtonLabel(item.locator, item.text || `Bold Penguin quote #${i + 1}`);
        const component = item.component || 'Page';
        const elementName = item.elementName || item.text || component;
        const label = `[${component}] ${buttonLabel}`;
        logStep(`[BP ${i + 1}/${bpItems.length}] ${label}`, 1);
        const r = await validateButtonClick(page, item.locator, `Bold Penguin: ${label}`, sourceUrl);
        bpResults.push({ ...r, label, buttonLabel, component, elementName });
      }

      const primary = bpResults.find(r => r.success) || bpResults[0] || {};
      const failures = bpResults.filter(r => !r.success);
      const backFailures = bpResults.filter(r => !r.backSuccess);
      const uniqueComponents = [...new Set(bpResults.map(r => r.component || 'Page'))];
      const uniqueElementNames = [...new Set(bpResults
        .map(r => (typeof r.elementName === 'string' && r.elementName.trim()) ? r.elementName : (r.component || 'Page'))
        .filter(Boolean))];
      const componentMap = {};
      for (const resultEntry of bpResults) {
        const component = resultEntry.component || 'Page';
        const elementName = (typeof resultEntry.elementName === 'string' && resultEntry.elementName.trim()) ? resultEntry.elementName : (resultEntry.buttonLabel || component);
        componentMap[component] = {
          elementName,
          finalUrl: resultEntry.finalUrl || '',
          applicationId: resultEntry.applicationId || '',
          backNavigation: resultEntry.backSuccess ? 'SUCCESS' : 'FAIL',
          backError: resultEntry.backError || '',
          status: resultEntry.success ? 'PASS' : (resultEntry.skipped ? 'SKIPPED' : 'FAIL')
        };
      }

      result.mainButtonName        = bpResults.map(r => r.buttonLabel).join(' | ');
      result.boldPenguinComponents = uniqueComponents.join(' | ');
      result.boldPenguinElementName = uniqueElementNames.join(' | ');
      result.boldPenguinMatchDetails = bpResults.map(r => {
        const component = r.component || 'Page';
        const elementName = (typeof r.elementName === 'string' && r.elementName.trim()) ? r.elementName : (r.buttonLabel || component);
        const status = r.success ? 'PASS' : (r.skipped ? 'SKIPPED' : 'FAIL');
        const finalUrl = r.finalUrl || ''; 
        const appId = r.applicationId || '';
        return `${component}: ${elementName} | ${status}${finalUrl ? ` | ${finalUrl}` : ''}${appId ? ` | ${appId}` : ''}`;
      }).join(' || ');
      result.componentResults = componentMap;
      result.mainStatus            = failures.length === 0 ? 'PASS' : 'FAIL';
      result.mainError             = failures.map(r => `${r.label}: ${r.error || 'unknown error'}`).join('; ');
      result.mainFinalUrl          = primary.finalUrl || '';
      result.mainApiUrl            = (!primary.href || primary.href.endsWith('#'))
                                       ? (primary.finalUrl || primary.href || '')
                                       : primary.href;
      result.mainApplicationId     = primary.applicationId || '';
      result.mainNewTabUrl         = primary.newTabUrl || '';
      result.mainNewTabStatus      = primary.newTabStatus || (primary.finalUrl ? 'No additional tab opened' : '');
      result.mainBackNav           = backFailures.length === 0 ? 'SUCCESS' : 'FAIL';
      result.mainBackError         = backFailures.map(r => `${r.label}: ${r.backError || ''}`).join('; ');
      result.remarks               = `Bold Penguin: ${bpResults.length} instance(s) | Components: ${result.boldPenguinComponents} | ` +
        bpResults.map(r => `${r.label}: ${r.remarks || ''}`).filter(Boolean).join(' | ');

      logStep(`Phase 1/3 complete: Bold Penguin ${result.mainStatus} (${bpResults.length} instance(s))`, 1);
    }

    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await waitForPageToSettle(page);
    await handleOverlays(page);

    logStep('Skipping non-Bold Penguin CTA validation per requirement.', 1);
    result.ctaStatus = 'N/A';
    result.ctaError = '';
    result.smallCtaPresent = 'No';
    result.smallCtaStatus = 'N/A';
    result.smallCtaUrls = '';
    result.smallCtaRedirectTargets = '';
    result.smallCtaFailureReasons = '';
    result.stickyCtaPresent = 'No';
    result.stickyCtaStatus = 'N/A';
    result.stickyCtaUrls = '';
    result.stickyCtaRedirectTargets = '';
    result.stickyCtaFailureReasons = '';
    result.remarks = [result.remarks, 'Only Bold Penguin validation was executed.'].filter(Boolean).join(' | ');

    const hasFailure = result.mainStatus === 'FAIL';
    const hasTest = result.mainStatus !== 'N/A';
    result.status = !hasTest ? 'N/A' : hasFailure ? 'FAIL' : 'PASS';
    result.error = result.mainError;

    const screenshot = path.join(SCREENSHOT_DIR, `screenshot_${index}_${Date.now()}.png`);
    logStep(`Capturing final screenshot: ${screenshot}`, 1);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    result.screenshot = screenshot;
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message;
    result.pageError = error.message;
  } finally {
    if (!isPageClosed(page)) await page.close().catch(() => {});
    logStep(`Finished validation for ${inputUrl} -> ${result.status}`, 1);
  }
  return result;
}

function writeReports(results, timestamp, modeName = 'run') {
  const componentNames = [...new Set(results.flatMap(r => Object.keys(r.componentResults || {})))];
  const componentColumns = componentNames.flatMap(component => [
    `${sanitizeReportColumnName(component)}_bold_penguin_final_url`,
    `${sanitizeReportColumnName(component)}_bold_penguin_application_id`,
    `${sanitizeReportColumnName(component)}_bold_penguin_back_navigation`,
    `${sanitizeReportColumnName(component)}_bold_penguin_back_error`
  ]);

  const headers = [
    'url',
    'bold_penguin_present',
    'bold_penguin_count',
    'bold_penguin_component',
    'bold_penguin_element_name',
    'bold_penguin_button_name',
    ...componentColumns,
    'overall_status',
    'error_details',
    'remarks'
  ];
  const rows = results.map(r => {
    const componentEntries = r.componentResults || {};
    const row = [
      r.url,
      r.boldPenguinDom,
      r.boldPenguinCount ?? 0,
      r.boldPenguinComponents ?? '',
      r.boldPenguinElementName ?? '',
      r.mainButtonName,
    ];
    for (const component of componentNames) {
      const details = componentEntries[component] || {};
      row.push(
        details.finalUrl || '',
        details.applicationId || '',
        details.backNavigation || '',
        details.backError || ''
      );
    }
    row.push(r.status, r.error, r.remarks);
    return row;
  });

  const base = `bold-penguin-cta-report_${modeName}_${timestamp}`;

  const csvPath = path.join(REPORTS_DIR, `${base}.csv`);
  fs.writeFileSync(csvPath, [headers.join(','), ...rows.map(row => row.map(escapeCsv).join(','))].join('\n'));

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Results');
  const xlsxPath = path.join(REPORTS_DIR, `${base}.xlsx`);
  XLSX.writeFile(workbook, xlsxPath);

  const htmlRows = results.map(r => {
    const componentEntries = r.componentResults || {};
    const cells = [
      `<td>${escapeHtml(r.url)}</td>`,
      `<td>${r.boldPenguinDom}</td>`,
      `<td>${r.boldPenguinCount ?? 0}</td>`,
      `<td>${escapeHtml(r.boldPenguinComponents || '')}</td>`,
      `<td>${escapeHtml(r.boldPenguinElementName || '')}</td>`,
      `<td>${escapeHtml(r.mainButtonName || '')}</td>`
    ];
    for (const component of componentNames) {
      const details = componentEntries[component] || {};
      cells.push(
        `<td>${escapeHtml(details.finalUrl || '')}</td>`,
        `<td>${escapeHtml(details.applicationId || '')}</td>`,
        `<td>${escapeHtml(details.backNavigation || '')}</td>`,
        `<td>${escapeHtml(details.backError || '')}</td>`
      );
    }
    cells.push(
      `<td>${r.status}</td>`,
      `<td>${escapeHtml(r.error)}</td>`,
      `<td>${escapeHtml(r.remarks)}</td>`
    );
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const htmlHeaders = [
    'URL', 'Bold Penguin Present', 'BP Count', 'BP Component', 'BP Element', 'Button Name',
    ...componentNames.flatMap(component => [
      `${sanitizeReportColumnName(component)} Final URL`,
      `${sanitizeReportColumnName(component)} Application ID`,
      `${sanitizeReportColumnName(component)} Back Nav`,
      `${sanitizeReportColumnName(component)} Back Error`
    ]),
    'Overall', 'Error', 'Remarks'
  ];
  const htmlHeaderHtml = htmlHeaders.map(header => `<th>${escapeHtml(header)}</th>`).join('');
  const htmlPath = path.join(REPORTS_DIR, `${base}.html`);
  fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><title>Bold Penguin Validation (${escapeHtml(modeName)})</title><style>body{font-family:Arial;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#164a7b;color:#fff}</style></head><body><h1>Bold Penguin Validation Results (${escapeHtml(modeName)})</h1><table><tr>${htmlHeaderHtml}</tr>${htmlRows}</table></body></html>`);
  logStep(`Reports written:\n  ${csvPath}\n  ${xlsxPath}\n  ${htmlPath}`);
}

async function runValidationSession(modeName, isMobileMode) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const urls = SINGLE_URL ? [SINGLE_URL] : (() => {
    if (!fs.existsSync(INPUT_CSV)) throw new Error(`CSV not found: ${INPUT_CSV}`);
    const records = parse(fs.readFileSync(INPUT_CSV, 'utf8'), { columns: true, skip_empty_lines: true });
    return records.map(row => row.URL || row.url || row.Url).filter(Boolean);
  })();
  if (!urls.length) throw new Error('No URLs found. Expected URL, url, or Url CSV column.');

  logStep(`Launching browser | headless=${!HEADED_MODE} | device=${isMobileMode ? 'iPhone 12' : 'desktop'} | mode=${modeName}`);
  const browser = await chromium.launch({ headless: !HEADED_MODE });
  const workerCount = Math.max(1, Math.min(PARALLEL_WORKERS, urls.length));
  const results = new Array(urls.length);
  let nextIndex = 0;
  let completed = 0;

  if (workerCount > 1) logStep(`Running ${urls.length} URLs across ${workerCount} parallel browser contexts`);
  logStep(`Starting validation run for ${urls.length} URL(s) | mode=${modeName} | file=${INPUT_CSV}`);

  const runWorker = async () => {
    const context = await browser.newContext(isMobileMode ? devices['iPhone 12'] : {});
    try {
      while (true) {
        const index = nextIndex++;
        if (index >= urls.length) break;
        logStep(`[start ${index + 1}/${urls.length}] ${urls[index]}`);
        try {
          results[index] = await validateUrl(context, urls[index], index + 1);
        } catch (error) {
          results[index] = {
            url: urls[index], status: 'FAIL',
            boldPenguinDom: 'No', boldPenguinCount: 0, boldPenguinComponents: '',
            mainStatus: 'N/A', mainError: '', mainFinalUrl: '', mainApiUrl: '',
            mainApplicationId: '', mainNewTabUrl: '', mainNewTabStatus: '',
            mainBackNav: 'N/A', mainBackError: '', mainButtonName: '',
            ctaStatus: 'N/A', ctaError: '',
            smallCtaPresent: 'No', smallCtaStatus: 'N/A', smallCtaUrls: '',
            smallCtaRedirectTargets: '', smallCtaFailureReasons: '',
            stickyCtaPresent: 'No', stickyCtaStatus: 'N/A', stickyCtaUrls: '',
            stickyCtaRedirectTargets: '', stickyCtaFailureReasons: '',
            pageError: error.message, error: error.message, remarks: '', screenshot: ''
          };
        }
        completed++;
        logStep(`[done ${completed}/${urls.length}] ${urls[index]} -> ${results[index].status}`);
        await context.clearCookies().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  };

  try {
    logStep(`Executing workers: ${workerCount}`);
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  } finally {
    await browser.close();
  }
  logStep('Generating final report files...');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  writeReports(results, stamp, modeName);
  return results;
}

(async () => {
  const requestedModes = RUN_BOTH_MODES ? ['desktop', 'mobile']
    : MOBILE_MODE ? ['mobile']
    : ['desktop'];

  const allResults = [];
  for (const modeName of requestedModes) {
    console.log(`\n=== Running ${modeName} mode ===`);
    const results = await runValidationSession(modeName, modeName === 'mobile');
    if (Array.isArray(results)) allResults.push({ modeName, results });
  }

  if (requestedModes.length > 1) {
    console.log('\nCompleted the requested desktop/mobile validation runs.');
  }

  const anyFailed = allResults.some(({ results }) => results.some(r => r && r.status === 'FAIL'));
  if (anyFailed) process.exitCode = 1;
})();