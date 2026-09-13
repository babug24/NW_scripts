/*
 * Bold Penguin / SmallCTA / StickyCTA E2E Validator
 * Dependencies: npm i playwright csv-parse xlsx
 * First time:  npx playwright install chromium
 * Examples:
 *   node bold-penguin-validator.js --url "https://example.com/page"
 *   node bold-penguin-validator.js --file urls.csv
 *   node bold-penguin-validator.js --file urls.csv --mobile --debug
 *   node bold-penguin-validator.js --file urls.csv --parallel 4
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
let HEADED_MODE = false;
let DEBUG_MODE = false;
let PARALLEL_WORKERS = 1;
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
  } else if (arg === '--mobile' || arg === '-m') MOBILE_MODE = true;
  else if (arg === '--headed' || arg === '-h') HEADED_MODE = true;
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

const SMALL_CTA_SELECTOR = 'ngx-web-small-cta, ngx-nationwide-small-cta, .small-cta-wrapper, .nw-small-cta, .nw-cta-small';
const STICKY_CTA_SELECTOR = 'ngx-web-sticky-cta, ngx-nationwide-sticky-cta, .sticky-cta, .sticky-cta-button-container, .sticky.bolt-background-vibrant-blue, [class*="sticky-cta" i], [class*="sticky"][class*="bolt-background-vibrant-blue"], [data-testid*="sticky" i], [data-name*="sticky" i]';
const MAIN_BOLD_PENGUIN_SELECTORS = [
  'a.button.nw-button--mint-dark.bold-penguin-quote',
  'a.bold-penguin-quote',
  'button.bold-penguin-quote',
  '[class*="bold-penguin-quote"]'
];
const DRAWER_SELECTOR = '[class*="drawer" i], [class*="offcanvas" i], .cdk-overlay-pane, [role="dialog"], [aria-modal="true"], .mat-drawer, .nw-drawer, [data-testid*="drawer" i], [data-name*="drawer" i]';
const ZIP_INPUT_SELECTOR = 'input[name*="zip" i], input[id*="zip" i], input[name*="postal" i], input[id*="postal" i], input[placeholder*="zip" i], input[aria-label*="zip" i], input[placeholder*="postal" i], input[aria-label*="postal" i]';
const ZIP_ERROR_EMPTY_MESSAGE = 'Enter your 5 or 9 digit ZIP Code.';
const ZIP_ERROR_INVALID_MESSAGE = 'Unable to find a valid state for the given Postal Code. Please try again using a 5 digit Postal Code.';
const VALID_TEST_ZIP = '10001';
const INVALID_TEST_ZIP = '00000';

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

async function handleOverlays(page) {
  // Deliberately limited to known consent UI: never click generic page buttons such as "Accept".
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
      const nodes = [...document.querySelectorAll([
        '[aria-busy="true"]', '[role="progressbar"]',
        '.page-loader', '.loading-spinner', '.loading-wheel', '.nw-spinner', '.bolt-spinner',
        '[class*="spinner" i]', '[class*="loading" i]', '[class*="loader" i]',
        '[id*="spinner" i]', '[id*="loading" i]', '[id*="loader" i]'
      ].join(','))];

      // A visible modal/overlay saying “Please wait” is always a blocking state.
      const waitModal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, [class*="overlay" i]')]
        .some(node => isVisible(node) && /please\s+wait|loading/i.test(node.innerText || node.textContent || ''));

      const visibleBlockers = nodes.filter(node => {
        if (!isVisible(node)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const classAndId = `${node.className || ''} ${node.id || ''}`.toLowerCase();
        // Count likely page blockers, not tiny decorative icons.
        return style.position === 'fixed' || style.position === 'absolute' ||
          rect.width >= 40 || rect.height >= 40 ||
          /spinner|loading|loader/.test(classAndId);
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
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
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

// Fallback for drawers/panels that reveal new links or buttons without a recognizable
// drawer/modal/dialog class name: diff the interactive elements visible before vs. after the click.
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
    if (!ancestor) return false;
    ancestor.setAttribute('data-cta-validator-panel', 'true');
    return true;
  }, beforeList).catch(() => false);
  return marked ? page.locator('[data-cta-validator-panel="true"]').first() : null;
}

// Many sticky CTAs expose their panel only through aria-controls, not a drawer/dialog class name.
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
      isZipSubmit: !!(zipForm && node.closest('form') === zipForm)
    }));
  }, ZIP_INPUT_SELECTOR).catch(() => []);
}

async function openStickyDrawer(page, item, sourceUrl) {
  // Always reload: the sticky CTA is a toggle, so clicking it on a page that already shows the
  // drawer would close it instead of reopening it.
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

async function validateDrawerContents(page, item, sourceUrl) {
  const rows = [];
  // Reopen from a clean load so the panel is found even when the earlier click left the page
  // in a state where the drawer markup is no longer matchable.
  const initialDrawer = await openStickyDrawer(page, item, sourceUrl);
  if (!initialDrawer) {
    console.log('  Drawer could not be reopened to enumerate its links');
    return rows;
  }

  const zipWidget = await findZipWidget(initialDrawer);
  const descriptors = await collectDrawerDescriptors(initialDrawer);
  console.log(`  Drawer links/buttons to validate: ${descriptors.filter(descriptor => !descriptor.isZipSubmit).length}`);

  for (const descriptor of descriptors) {
    if (descriptor.isZipSubmit) continue;
    const rowText = 'StickyCTA Drawer: ' + (descriptor.text || descriptor.tag);
    const drawerLocator = await openStickyDrawer(page, item, sourceUrl);
    if (!drawerLocator) {
      rows.push({ text: rowText, href: descriptor.href, finalUrl: '', success: false, skipped: false, backSuccess: false, error: 'Drawer did not reopen', remarks: '', backUrl: '' });
      continue;
    }
    const candidates = drawerLocator.locator('a[href], button, [role="button"]');
    const target = descriptor.text ? candidates.filter({ hasText: descriptor.text }).first() : candidates.nth(descriptor.index);
    const validation = await validateButtonClick(page, target, rowText, sourceUrl);
    rows.push({
      text: rowText,
      href: validation.href || descriptor.href,
      finalUrl: validation.finalUrl || '',
      success: validation.success,
      skipped: validation.skipped || false,
      backSuccess: validation.backSuccess,
      error: validation.error || validation.backError || '',
      remarks: validation.remarks || '',
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

    console.log(`  Testing ${description}`);
    console.log(`  Source: ${sourceUrl}`);
    console.log(`  Href: ${href || '(JavaScript/router button)'}`);

    // Only a top-level StickyCTA can open a drawer. Clicks on elements inside an already-open
    // drawer must be judged by navigation/popup, otherwise the open drawer is mistaken for a result.
    const isStickyCta = description.startsWith('StickyCTA') && !description.startsWith('StickyCTA Drawer');
    const beforeFingerprint = isStickyCta ? await captureVisibleInteractiveFingerprint(page) : null;
    const expandedBefore = await locator.getAttribute('aria-expanded').catch(() => null);

    // Context-level event catches target=_blank links and window.open(), not only Playwright popups.
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
      console.log(`  Normal click failed: ${normalClickError.message}; trying force click`);
      await locator.click({ force: true, timeout: BUTTON_TIMEOUT });
    }

    // Do not rely on waitForURL alone. A SPA may complete a very fast navigation, and new-tab
    // links must be caught via the context event. Polling also gives useful, deterministic output.
    let navigated = false;
    let drawerLocator = null;
    const redirectTimeout = description.startsWith('Bold Penguin') ? 30000 : CTA_WAIT_TIMEOUT;
    for (let elapsed = 0; elapsed < redirectTimeout; elapsed += 250) {
      if (normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(sourceUrl)) {
        navigated = true;
      }
      // Only Sticky CTA buttons are expected to open a drawer instead of navigating/popping a new tab.
      if (isStickyCta && !navigated && !openedPage && !drawerLocator) {
        drawerLocator = await getVisibleDrawer(page).catch(() => null) ||
          await findControlledPanel(page, locator).catch(() => null);
      }
      // A StickyCTA can both open a popup and navigate the source tab. Observe both outcomes.
      if (navigated && openedPage) break;
      if (navigated && elapsed >= 2000) break;
      if (openedPage && elapsed >= 2000) break;
      if (drawerLocator && elapsed >= 1000) break;
      await page.waitForTimeout(250);
    }
    page.context().off('page', onPage);
    page.off('framenavigated', onMainFrameNavigation);

    // Class-based drawer selectors miss panels that reveal plain content (e.g. inline rich text
    // with new links) instead of a recognizable drawer/modal/dialog wrapper.
    if (!drawerLocator && !navigated && !openedPage && isStickyCta) {
      drawerLocator = await findRevealedPanel(page, beforeFingerprint).catch(() => null);
    }

    if (drawerLocator && !navigated && !openedPage) {
      console.log(`  Drawer opened by ${description}`);
      return { success: true, isDrawer: true, href, finalUrl: '', title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: 'Drawer opened after click' };
    }

    // Accordion/dropdown toggles inside a CTA region are in-page controls, not navigation targets.
    // An expansion that reveals a panel is still a drawer and must have its links validated.
    if (!navigated && !openedPage && expandedBefore !== null) {
      const expandedAfter = await locator.getAttribute('aria-expanded').catch(() => null);
      if (expandedAfter !== null && expandedAfter !== expandedBefore) {
        if (expandedAfter === 'true') {
          console.log(`  Panel expanded by ${description}; validating its contents`);
          return { success: true, isDrawer: true, href, finalUrl: '', title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `Panel expanded after click (aria-expanded ${expandedBefore} -> ${expandedAfter})` };
        }
        console.log(`  In-page control toggled by ${description} (aria-expanded ${expandedBefore} -> ${expandedAfter})`);
        return { success: true, skipped: true, href, finalUrl: '', title: '', backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `In-page control: aria-expanded ${expandedBefore} -> ${expandedAfter}; no navigation expected` };
      }
    }

    if (openedPage && !navigated) {
      await openedPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(error => { popupError = error; });
      await waitForPageToSettle(openedPage);
      const finalUrl = openedPage.url();
      const title = await openedPage.title().catch(() => '');
      const pageError = await getPageErrorReason(openedPage, finalUrl, title);
      await openedPage.close().catch(() => {});
      if (popupError) throw popupError;
      if (pageError) throw new Error(pageError);
      console.log(`  Popup destination validated: ${finalUrl}`);
      return { success: true, href, finalUrl, title, backSuccess: true, backError: '', backUrl: sourceUrl, remarks: `New-window destination validated: ${finalUrl}` };
    }

    if (!navigated) {
      // A real anchor should be independently verified if the click was intercepted by browser/site behavior.
      // This produces a clear failure instead of hanging or incorrectly reporting a PASS.
      return {
        success: false, href, finalUrl: '', title: '', backSuccess: false,
        backError: 'No navigation or new tab detected after click',
        remarks: `No external destination detected within ${redirectTimeout}ms | Observed main-frame URLs: ${observedMainFrameUrls.join(' -> ')}`,
        error: `CTA did not navigate from ${sourceUrl}${href ? ` (expected href: ${href})` : ''}`
      };
    }

    let popupObservation = '';
    if (openedPage) {
      await openedPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      popupObservation = openedPage.url();
      await openedPage.close().catch(() => {});
    }

    await waitForPageToSettle(page);
    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const pageError = await getPageErrorReason(page, finalUrl, title);
    if (pageError) throw new Error(pageError);
    console.log(`  Destination validated: ${finalUrl}`);

    console.log('  Validating browser back navigation');
    let backSuccess = false;
    let backError = '';
    try {
      // Tolerate fast navigations where the spinner might not appear at all.
      const spinnerLocator = page.locator('.bolt-waiting-indicator-wc--spinner');
      const spinnerAppeared = await spinnerLocator.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);

      await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      const settleAfterBack = await waitForPageToSettle(page, NAV_TIMEOUT);
      const urlMatches = normalizeUrlForComparison(page.url()) === normalizeUrlForComparison(returnToUrl);

      // If the spinner appeared it must clear; otherwise the page may be stuck behind a transparent overlay.
      if (spinnerAppeared) {
        await spinnerLocator.waitFor({ state: 'hidden', timeout: 10000 }).catch(error => {
          backError = `Waiting indicator did not clear after back navigation: ${error.message}`;
        });
      }

      const mainContentVisible = !backError && await page.locator('#main-content').first().isVisible().catch(() => false);
      backSuccess = urlMatches && settleAfterBack.success && !backError && mainContentVisible;

      if (!backError) {
        if (!urlMatches) {
          backError = `Browser back returned ${page.url()} instead of ${returnToUrl}`;
        } else if (!settleAfterBack.success) {
          backError = `Browser back reached the expected URL but the page did not finish rendering: ${settleAfterBack.reason}`;
        } else if (!mainContentVisible) {
          backError = 'Browser back landed on the expected URL but #main-content is not visible';
        }
      }
    } catch (error) {
      backError = `Browser back failed: ${error.message}`;
    }

    if (!backSuccess) {
      await page.goto(returnToUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
      await waitForPageToSettle(page).catch(() => {});
    }

    return { success: backSuccess, href, finalUrl, title, backSuccess, backError, backUrl: page.url(), remarks: `Observed main-frame URLs: ${observedMainFrameUrls.join(' -> ')} | Destination: ${finalUrl}${popupObservation ? ` | Additional popup observed: ${popupObservation}` : ''} | Back-navigation URL: ${page.url()}${page.url().endsWith('#') ? ' | Application added trailing # fragment on back navigation' : ''}`, error: backSuccess ? '' : backError };
  } catch (error) {
    if (!isPageClosed(page) && normalizeUrlForComparison(page.url()) !== normalizeUrlForComparison(returnToUrl)) {
      await page.goto(returnToUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    }
    return { success: false, href, finalUrl: '', title: '', backSuccess: false, backError: error.message, backUrl: !isPageClosed(page) ? page.url() : '', remarks: `Validation exception: ${error.message}`, error: error.message };
  }
}

async function findBoldPenguinLocator(page) {
  for (const selector of MAIN_BOLD_PENGUIN_SELECTORS) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { selector, locator };
  }
  return null;
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

    // Includes href anchors and JavaScript/router buttons within the specific CTA container.
    // Bold Penguin anchors can be rendered without href; their click handler supplies the destination.
    // Include them explicitly so StickyCTA is click-validated rather than reported as N/A.
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
        // Design-system buttons (e.g. bolt-button) render a shadow <button> whose label is
        // slotted from the host, so the host and nearest labelled ancestor are checked too.
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
          // A wrapper that contains another clickable candidate is layout markup, not a CTA itself.
          isWrapper: !!node.querySelector('a[href], button, [role="button"], [onclick], [routerLink], [data-url], [data-href]'),
          receivesPointer: hit === node || node.contains(hit) || hit?.contains(node) || (!!shadowHost && (hit === shadowHost || shadowHost.contains(hit)))
        };
      }).catch(() => null);
      if (!data?.visible) continue;
      if (data.isWrapper) continue;
      const resolvedHref = data.href ? new URL(data.href, page.url()).href : '';
      // An unlabelled element with no destination cannot be reported meaningfully and is not a CTA.
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

    // Prefer the element the browser can actually receive a click on. For external links,
    // prefer the genuine target=_blank instance over responsive/template duplicates.
    const score = (item.receivesPointer ? 100 : 0) +
      (item.target === '_blank' ? 20 : 0) +
      (item.href ? 5 : 0);
    const current = grouped.get(key);
    if (!current || score > current.score) grouped.set(key, { ...item, score });
  }
  return [...grouped.values()];
}
async function revealStickyCta(page) {
  // The StickyCTA is scroll-dependent. Reapply scrolling after every prior navigation/back.
  for (const ratio of [0.4, 0.75, 1]) {
    await page.evaluate(value => window.scrollTo(0, Math.floor(document.body.scrollHeight * value)), ratio);
    await page.waitForTimeout(500);
  }
  await handleOverlays(page);
}

async function validateCtaGroup(page, sourceUrl, items, category) {
  const output = [];
  const uniqueItems = deduplicateCtas(items);
  console.log(`  ${category} unique buttons to validate: ${uniqueItems.length}`);

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

    // Clicking the StickyCTA can open a drawer instead of navigating; classify and validate
    // every button/link (and any ZIP-code flow) inside it as its own set of results.
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
  // Some Angular deployments inject StickyCTA only after scroll activity, not after one jump.
  for (const position of [0.35, 0.7, 1]) {
    await page.evaluate((ratio) => window.scrollTo(0, Math.floor(document.body.scrollHeight * ratio)), position);
    await page.waitForTimeout(750);
  }
  await handleOverlays(page);

  // Legacy DevL pages hydrate .nw-small-cta after initial page load. Wait for either modern
  // or legacy SmallCTA markup before collecting it.
  await page.locator(SMALL_CTA_SELECTOR).first()
    .waitFor({ state: 'attached', timeout: 20000 })
    .catch(() => {});

  // Collect StickyCTA first while the page is still at the bottom. Collecting SmallCTA scrolls
  // to its inline containers and can remove/hide a lazy sticky banner in some environments.
  let sticky = await collectCtasFromContainers(page, STICKY_CTA_SELECTOR, 'StickyCTA');
  let small = await collectCtasFromContainers(page, SMALL_CTA_SELECTOR, 'SmallCTA');

  // Direct legacy fallback: handles CMS markup such as <div class="nw-small-cta"> even if the
  // surrounding component is inserted after the primary collection pass.
  if (!small.length) {
    await page.waitForTimeout(2000);
    small = await collectCtasFromContainers(page, '.nw-small-cta, .nw-cta-small', 'SmallCTA');
  }

  // Diagnostic fallback: captures a StickyCTA implementation whose wrapper name differs by environment.
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

  console.log(`  SmallCTA found: ${small.length}; StickyCTA found: ${sticky.length}`);
  if (DEBUG_MODE && !sticky.length) {
    const stickyLike = await page.locator('*').evaluateAll(nodes => nodes
      .filter(node => `${node.tagName} ${node.className || ''} ${node.id || ''}`.toLowerCase().includes('sticky'))
      .slice(0, 20)
      .map(node => ({ tag: node.tagName.toLowerCase(), className: String(node.className || ''), id: node.id || '' }))
    ).catch(() => []);
    console.log('  DEBUG: sticky-like DOM elements:', JSON.stringify(stickyLike));
  }

  // Validate in the requested sequence: Bold Penguin (already done by the caller), then
  // SmallCTA, then StickyCTA. Each group re-navigates to sourceUrl before every item, and
  // StickyCTA re-applies scroll via revealStickyCta, so running SmallCTA first is safe.
  console.log('  Phase 2/3: SmallCTA validation');
  const smallDetails = await validateCtaGroup(page, sourceUrl, small, 'SmallCTA');
  console.log(`  Phase 2/3 complete: SmallCTA rows validated: ${smallDetails.length}`);
  console.log('  Phase 3/3: StickyCTA validation');
  const stickyDetails = await validateCtaGroup(page, sourceUrl, sticky, 'StickyCTA');
  console.log(`  Phase 3/3 complete: StickyCTA rows validated: ${stickyDetails.length}`);
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
    stickyCtaPresent: sticky.length > 0 ? 'Yes' : 'No',
    stickyCtaStatus: stickySummary.status,
    stickyCtaUrls: stickySummary.urls,
    // Only verified post-click destinations; blank when a StickyCTA click did not navigate.
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
  const result = { url: inputUrl, status: 'FAIL', boldPenguinDom: 'No', mainStatus: 'N/A', mainError: '', mainFinalUrl: '', mainApiUrl: '', mainBackNav: 'N/A', mainBackError: '', mainButtonName: '', ctaStatus: 'N/A', ctaError: '', smallCtaPresent: 'No', smallCtaStatus: 'N/A', smallCtaUrls: '', smallCtaRedirectTargets: '', stickyCtaPresent: 'No', stickyCtaStatus: 'N/A', stickyCtaUrls: '', stickyCtaRedirectTargets: '', stickyCtaFailureReasons: '', pageError: '', error: '', remarks: '', screenshot: '' };
  try {
    const nav = await navigateWithRetry(page, inputUrl);
    await handleOverlays(page);
    const sourceUrl = page.url(); // Use the real URL after redirect for all back-navigation checks.

    if (nav.statusCode >= 400) throw new Error(`HTTP ${nav.statusCode}`);
    const sourceError = await getPageErrorReason(page, sourceUrl, await page.title().catch(() => ''));
    if (sourceError) throw new Error(sourceError);

    result.boldPenguinDom = await page.locator('[class*="bold-penguin"], [id*="bold-penguin"]').count().then(count => count ? 'Yes' : 'No');
    const main = await findBoldPenguinLocator(page);

    if (main) {
      console.log('  Phase 1/3: Bold Penguin validation');
      result.mainButtonName = await getButtonLabel(main.locator, 'Bold Penguin quote');
      const mainResult = await validateButtonClick(page, main.locator, `Bold Penguin: ${result.mainButtonName}`, sourceUrl);
      result.mainStatus = mainResult.success ? 'PASS' : 'FAIL';
      result.mainError = mainResult.error || '';
      result.mainFinalUrl = mainResult.finalUrl || '';
      result.mainApiUrl = (!mainResult.href || mainResult.href.endsWith('#'))
        ? (mainResult.finalUrl || mainResult.href || '')
        : mainResult.href;
      result.mainBackNav = mainResult.backSuccess ? 'SUCCESS' : 'FAIL';
      result.mainBackError = mainResult.backError || '';
      result.remarks = `Bold Penguin: ${mainResult.remarks || ''}`;
      console.log(`  Phase 1/3 complete: Bold Penguin ${result.mainStatus}`);
    }

    // A Bold Penguin drawer stays open and blocks scrolling/collection, so always reload the
    // source page before the CTA phases instead of only when the URL changed.
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await waitForPageToSettle(page);
    await handleOverlays(page);

    let ctas;
    try {
      ctas = await validateAllCtas(page, sourceUrl);
    } catch (ctaError) {
      console.log(`  CTA validation error: ${ctaError.message}`);
      ctas = { status: 'FAIL', error: ctaError.message, details: [], smallCtaPresent: 'No', smallCtaStatus: 'N/A', smallCtaUrls: '', smallCtaRedirectTargets: '', stickyCtaPresent: 'No', stickyCtaStatus: 'N/A', stickyCtaUrls: '', stickyCtaRedirectTargets: '', stickyCtaFailureReasons: ctaError.message, remarks: '' };
    }
    result.ctaStatus = ctas.status;
    result.ctaError = ctas.error;
    result.smallCtaPresent = ctas.smallCtaPresent;
    result.smallCtaStatus = ctas.smallCtaStatus;
    result.smallCtaUrls = ctas.smallCtaUrls;
    result.smallCtaRedirectTargets = ctas.smallCtaRedirectTargets;
    result.stickyCtaPresent = ctas.stickyCtaPresent;
    result.stickyCtaStatus = ctas.stickyCtaStatus;
    result.stickyCtaUrls = ctas.stickyCtaUrls;
    result.stickyCtaRedirectTargets = ctas.stickyCtaRedirectTargets;
    result.stickyCtaFailureReasons = ctas.stickyCtaFailureReasons;
    result.remarks = [result.remarks, ctas.remarks].filter(Boolean).join(' | ');

    const hasFailure = result.mainStatus === 'FAIL' || result.ctaStatus === 'FAIL';
    const hasTest = result.mainStatus !== 'N/A' || result.ctaStatus !== 'N/A';
    result.status = !hasTest ? 'N/A' : hasFailure ? 'FAIL' : 'PASS';
    result.error = [result.mainError, result.ctaError].filter(Boolean).join('; ');

    const screenshot = path.join(SCREENSHOT_DIR, `screenshot_${index}_${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    result.screenshot = screenshot;
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message;
    result.pageError = error.message;
  } finally {
    if (!isPageClosed(page)) await page.close().catch(() => {});
    console.log(`  Finished validation for ${inputUrl} -> ${result.status}`);
  }
  return result;
}

function writeReports(results, timestamp) {
  const headers = [
    'url',
    'bold_penguin_present',
    'bold_penguin_button_name',
    'bold_penguin_url',
    'bold_penguin_final_url',
    'bold_penguin_back_navigation',
    'bold_penguin_back_error',
    'bold_penguin_status',
    'small_cta_present',
    'small_cta_urls',
    'small_cta_redirect_targets',
    'small_cta_status',
    'sticky_cta_present',
    'sticky_cta_urls',
    'sticky_cta_failure_reasons',
    'sticky_cta_status',
    'overall_status',
    'error_details',
    'remarks'
  ];
  const rows = results.map(r => [
    r.url, r.boldPenguinDom, r.mainButtonName, r.mainApiUrl, r.mainFinalUrl,
    r.mainBackNav, r.mainBackError, r.mainStatus,
    r.smallCtaPresent, r.smallCtaUrls, r.smallCtaRedirectTargets, r.smallCtaStatus,
    r.stickyCtaPresent, r.stickyCtaUrls, r.stickyCtaFailureReasons, r.stickyCtaStatus,
    r.status, r.error, r.remarks
  ]);
  const csvPath = path.join(REPORTS_DIR, `bold-penguin-cta-report_${timestamp}.csv`);
  fs.writeFileSync(csvPath, [headers.join(','), ...rows.map(row => row.map(escapeCsv).join(','))].join('\n'));

  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Results');
  const xlsxPath = path.join(REPORTS_DIR, `bold-penguin-cta-report_${timestamp}.xlsx`);
  XLSX.writeFile(workbook, xlsxPath);

  const htmlRows = results.map(r => `<tr><td>${escapeHtml(r.url)}</td><td>${r.mainStatus}</td><td>${r.mainBackNav}</td><td>${r.smallCtaStatus}</td><td>${r.stickyCtaStatus}</td><td>${r.status}</td><td>${escapeHtml(r.error)}</td></tr>`).join('');
  const htmlPath = path.join(REPORTS_DIR, `bold-penguin-cta-report_${timestamp}.html`);
  fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><title>CTA Validation</title><style>body{font-family:Arial;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}th{background:#164a7b;color:#fff}</style></head><body><h1>Bold Penguin / SmallCTA / StickyCTA E2E Results</h1><table><tr><th>URL</th><th>Bold Penguin</th><th>Back Nav</th><th>SmallCTA</th><th>StickyCTA</th><th>Overall</th><th>Error</th></tr>${htmlRows}</table></body></html>`);
  console.log(`Reports written:\n  ${csvPath}\n  ${xlsxPath}\n  ${htmlPath}`);
}

(async () => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const urls = SINGLE_URL ? [SINGLE_URL] : (() => {
    if (!fs.existsSync(INPUT_CSV)) throw new Error(`CSV not found: ${INPUT_CSV}`);
    const records = parse(fs.readFileSync(INPUT_CSV, 'utf8'), { columns: true, skip_empty_lines: true });
    return records.map(row => row.URL || row.url || row.Url).filter(Boolean);
  })();
  if (!urls.length) throw new Error('No URLs found. Expected URL, url, or Url CSV column.');

  const browser = await chromium.launch({ headless: !HEADED_MODE });
  const workerCount = Math.max(1, Math.min(PARALLEL_WORKERS, urls.length));
  // Results are stored by input index so the report order never depends on completion order.
  const results = new Array(urls.length);
  let nextIndex = 0;
  let completed = 0;

  if (workerCount > 1) console.log(`Running ${urls.length} URLs across ${workerCount} parallel browser contexts`);

  const runWorker = async () => {
    // Each worker gets its own context so cookie clearing and popups never cross workers.
    const context = await browser.newContext(MOBILE_MODE ? devices['iPhone 12'] : {});
    try {
      while (true) {
        const index = nextIndex++;
        if (index >= urls.length) break;
        console.log(`\n[start ${index + 1}/${urls.length}] ${urls[index]}`);
        try {
          results[index] = await validateUrl(context, urls[index], index + 1);
        } catch (error) {
          results[index] = { url: urls[index], status: 'FAIL', boldPenguinDom: 'No', mainStatus: 'N/A', mainError: '', mainFinalUrl: '', mainApiUrl: '', mainBackNav: 'N/A', mainBackError: '', mainButtonName: '', ctaStatus: 'N/A', ctaError: '', smallCtaPresent: 'No', smallCtaStatus: 'N/A', smallCtaUrls: '', smallCtaRedirectTargets: '', stickyCtaPresent: 'No', stickyCtaStatus: 'N/A', stickyCtaUrls: '', stickyCtaRedirectTargets: '', stickyCtaFailureReasons: '', pageError: error.message, error: error.message, remarks: '', screenshot: '' };
        }
        completed++;
        console.log(`[done ${completed}/${urls.length}] ${urls[index]} -> ${results[index].status}`);
        await context.clearCookies().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  };

  try {
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  } finally {
    await browser.close();
  }
  writeReports(results, new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15));
})();
