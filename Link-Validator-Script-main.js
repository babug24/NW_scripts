const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
 
// ==================== COMMAND-LINE ARGUMENTS ====================
const args = process.argv.slice(2);
let csvFileName = 'url.csv'; // Default file
let urlArg = null;          // --url    : single URL to test (creates temporary CSV)
let MOBILE_MODE = false;   // --mobile  : force mobile-only run
let UNIFIED_MODE = false;  // --unified : desktop + mobile merged in one run
let PRIVATE_MODE = true;   // --private : accepted for compatibility (Playwright context is private by default)
let REPORT_ALL_MODE = true; // default: include all discovered links/items in reports (no exclusion filters)

function printUsage() {
  console.log('Usage: node Link-Validator-Script-main.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --file <csvFile>      CSV file path/name (searches project root, then input_Data/ for relative names)');
  console.log('  --file=<csvFile>      Same as above');
  console.log('  --url <url>           Single URL to test (creates temporary CSV, overrides --file)');
  console.log('  --url=<url>           Same as above');
  console.log('  --private             Accepted for compatibility (runs in private browser context by default)');
  console.log('  --report-all          Include all discovered items in reports (default behavior)');
  console.log('  --report-filtered     Use legacy filtered reporting (may drop excluded rows)');
  console.log('  --mobile              Run mobile-only mode (390x844 viewport)');
  console.log('  --unified             Run unified mode (desktop + mobile merge)');
  console.log('  -h, --help            Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  node Link-Validator-Script-main.js');
  console.log('  node Link-Validator-Script-main.js --file UAT_Regression.csv');
  console.log('  node Link-Validator-Script-main.js --url https://example.com/page');
  console.log('  node Link-Validator-Script-main.js --mobile --url=https://example.com/page');
  console.log('  node Link-Validator-Script-main.js --unified --file=url.csv');
}

function parseCliArgs(argv) {
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--mobile') {
      MOBILE_MODE = true;
      continue;
    }

    if (arg === '--unified') {
      UNIFIED_MODE = true;
      continue;
    }

    if (arg === '--private') {
      PRIVATE_MODE = true;
      continue;
    }

    if (arg === '--report-all') {
      REPORT_ALL_MODE = true;
      continue;
    }

    if (arg === '--report-filtered') {
      REPORT_ALL_MODE = false;
      continue;
    }

    if (arg === '--file') {
      const nextValue = argv[i + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        console.error('❌ Missing value for --file');
        printUsage();
        process.exit(1);
      }
      csvFileName = nextValue;
      i++;
      continue;
    }

    if (arg.startsWith('--file=')) {
      const value = arg.slice('--file='.length).trim();
      if (!value) {
        console.error('❌ Empty value provided for --file');
        printUsage();
        process.exit(1);
      }
      csvFileName = value;
      continue;
    }

    if (arg === '--url') {
      const nextValue = argv[i + 1];
      if (!nextValue || nextValue.startsWith('--')) {
        console.error('❌ Missing value for --url');
        printUsage();
        process.exit(1);
      }
      urlArg = nextValue;
      i++;
      continue;
    }

    if (arg.startsWith('--url=')) {
      const value = arg.slice('--url='.length).trim();
      if (!value) {
        console.error('❌ Empty value provided for --url');
        printUsage();
        process.exit(1);
      }
      urlArg = value;
      continue;
    }

    if (arg.startsWith('--')) {
      unknownFlags.push(arg);
    }
  }

  return { unknownFlags, urlArg };
}

function resolveCsvFilePath(fileName) {
  const candidatePaths = [];

  if (path.isAbsolute(fileName)) {
    candidatePaths.push(path.normalize(fileName));
  } else {
    candidatePaths.push(path.join(__dirname, fileName));
    candidatePaths.push(path.join(__dirname, 'input_Data', fileName));
  }

  const resolvedPath = candidatePaths.find(candidate => fs.existsSync(candidate));

  return {
    resolvedPath: resolvedPath || candidatePaths[0],
    candidatePaths
  };
}

function normalizeSeedUrl(rawUrl) {
  const trimmedUrl = (rawUrl || '').trim();

  if (!trimmedUrl) {
    return '';
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmedUrl)) {
    return trimmedUrl;
  }

  if (trimmedUrl.startsWith('//')) {
    return `https:${trimmedUrl}`;
  }

  return `https://${trimmedUrl}`;
}

const { unknownFlags, urlArg: extractedUrlArg } = parseCliArgs(args);
if (extractedUrlArg) {
  urlArg = extractedUrlArg;
}
if (unknownFlags.length > 0) {
  console.log(`⚠️ Unknown option(s) ignored: ${unknownFlags.join(', ')}`);
  console.log('   Use --help to view supported options.');
}
// --unified implicitly runs at desktop viewport for the primary page
// (mobile extraction is done via a secondary page per URL)
if (UNIFIED_MODE) MOBILE_MODE = false;

// If --url flag provided, create temporary CSV file
if (urlArg) {
  const tempCsvPath = path.join(__dirname, '.url-temp.csv');
  const normalizedUrl = normalizeSeedUrl(urlArg);
  fs.writeFileSync(tempCsvPath, `Environment,url\nSingle,${normalizedUrl}\n`, 'utf-8');
  csvFileName = '.url-temp.csv';
  console.log(`🔗 Single URL mode: ${normalizedUrl}`);
}
 
// ==================== CONFIGURATION ====================
const { resolvedPath: CSV_FILE, candidatePaths: CSV_CANDIDATE_PATHS } = resolveCsvFilePath(csvFileName);
const REPORT_DIR = path.join(__dirname, 'reports');
// Viewport dimensions driven by run mode
const VIEWPORT = MOBILE_MODE
  ? { width: 390, height: 844 }    // Mobile: iPhone 14 Pro equivalent
  : { width: 1920, height: 1080 };  // Desktop: full HD
const MOBILE_VIEWPORT = { width: 390, height: 844 }; // used by unified mode secondary pass
const CSV_FILE_DISPLAY = path.relative(__dirname, CSV_FILE) || CSV_FILE;
console.log(`📄 Using CSV file: ${CSV_FILE_DISPLAY}`);
if (UNIFIED_MODE) {
  console.log('🔀 Run mode: UNIFIED (desktop 1920×1080 + mobile 390×844) — full coverage, single run');
} else {
  console.log(`📱 Run mode: ${MOBILE_MODE ? 'MOBILE (390×844) — mobile-only elements INCLUDED' : 'DESKTOP (1920×1080) — mobile-only elements SKIPPED'}`);
}
if (REPORT_ALL_MODE) {
  console.log('📊 Report mode: ALL ITEMS INCLUDED (container/protocol/text filters disabled for reporting)');
} else {
  console.log('📊 Report mode: FILTERED (legacy exclusions enabled)');
}
 
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 60000; // 60 seconds - increased for slow-loading pages
// Excluded from validation — has its own dedicated validation script
const EXCLUDED_CONTAINER_SELECTOR = '.bolt-header-wc--menuBar-wrapper';
// Also exclude by the web component host element (catches slotted/light-DOM links inside bolt-header-wc)
const EXCLUDED_HOST_SELECTOR = 'bolt-header-wc';
// Exception: the following header panel components live inside bolt-header-wc but contain
// page-specific content set in Tridion that MUST be validated by this script:
//   .bolt-header-panel-promos  — promo tile drawer (CSS class on a <div>)
//   .bolt-header-panel-footer  — footer link row inside header drawers (CSS class on a <div>)
const INCLUDED_PANEL_SELECTOR = '.bolt-header-panel-promos, .bolt-header-panel-footer';
const VISUAL_PROMO_MAP_SELECTOR = 'ngx-web-visual-content-promo-map, ngx-web-visual-content-promo';
const VISUAL_PROMO_MAP_TRIGGER_SELECTOR = 'button, bolt-button, [role="button"], summary, [aria-expanded], [aria-controls]';
const STICKY_CTA_SELECTOR = 'ngx-web-sticky-cta';
const STICKY_CTA_TRIGGER_SELECTOR = 'bolt-button#stickyCtaButton, bolt-button[type="primary"], bolt-button';
const ACCORDION_ITEM_SELECTOR = 'li.accordion-item';
const ACCORDION_TRIGGER_SELECTOR = 'a[role="tab"], button[aria-expanded], [role="button"][aria-expanded], .accordion-title';
const BATCH_SIZE = 100; // Process 100 URLs before restarting browser to prevent memory leaks
const BATCH_PAUSE_MS = 2000; // Pause 2 seconds between batches
const STABILIZATION_PASSES = 3; // Re-extract multiple times to reduce transient misses
const STABILIZATION_DELAY_MS = 1200; // Delay between extraction passes
const JS_NAVIGATION_CTA_TEXT_PATTERN = /\b(start|get|request)\b.*\b(quote|estimate)\b|\bquote\b/i;
const JS_NAVIGATION_CTA_ATTR_PATTERN = /(quote|estimate|getaquote|bold[-_]?penguin|redirect|navigate|api)/i;

function buildLinkKey(link) {
  return `${link.href || ''}|${link.rawHref || ''}|${link.text || ''}|${link.target || ''}|${link.elementType || ''}|${link.sourceComponent || ''}|${link.sourceElement || ''}`;
}

function mergeLinkArrays(baseLinks, extraLinks, defaultViewportSource = null) {
  const byKey = new Map(baseLinks.map(link => [buildLinkKey(link), link]));
  for (const link of extraLinks) {
    const key = buildLinkKey(link);
    const normalized = defaultViewportSource
      ? { ...link, viewportSource: link.viewportSource || defaultViewportSource }
      : link;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, normalized);
      continue;
    }

    if (normalized.viewportSource) {
      if (!existing.viewportSource) {
        existing.viewportSource = normalized.viewportSource;
      } else if (existing.viewportSource !== normalized.viewportSource) {
        existing.viewportSource = 'Both';
      }
    }
  }
  return Array.from(byKey.values());
}

function buildExpectedLinkKey(link) {
  return `${link.text || ''}|${link.tagName || ''}|${link.linkStatus || ''}|${link.outerHtml || ''}`;
}

function mergeExpectedLinkArrays(baseLinks, extraLinks) {
  const byKey = new Map(baseLinks.map(link => [buildExpectedLinkKey(link), link]));
  for (const link of extraLinks) {
    const key = buildExpectedLinkKey(link);
    if (!byKey.has(key)) {
      byKey.set(key, link);
    }
  }

  const merged = Array.from(byKey.values());
  merged._expectedCount = merged.length;
  return merged;
}

async function expandVisualPromoMapLinks(page) {
  const components = page.locator(VISUAL_PROMO_MAP_SELECTOR);
  const componentCount = await components.count().catch(() => 0);
  if (componentCount === 0) return 0;

  let expandedCount = 0;

  for (let index = 0; index < componentCount; index++) {
    const component = components.nth(index);

    // Some promo components are rendered below the fold; scroll to make
    // framework-managed controls reliably interactable before probing them.
    await component.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);

    let beforeCount = 0;
    try {
      beforeCount = await component.locator('a[href]').count();
    } catch (_) {
      continue;
    }

    try {
      const triggers = component.locator(VISUAL_PROMO_MAP_TRIGGER_SELECTOR);
      const triggerCount = await triggers.count().catch(() => 0);
      if (triggerCount === 0) continue;

      // Track the largest anchor count observed while toggling available controls.
      // Some promo-map variants expose multiple controls, each revealing a different
      // subset of links; stopping after the first increase can miss required links.
      let maxAnchorCount = beforeCount;

      for (let triggerIndex = 0; triggerIndex < triggerCount; triggerIndex++) {
        const trigger = triggers.nth(triggerIndex);
        if (!(await trigger.isVisible().catch(() => false))) continue;

        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(100);

        await trigger.click({ force: true, timeout: 3000 });
        // Angular/CMS content can hydrate asynchronously after click.
        // Poll briefly so late-rendered anchors are still detected.
        let afterCount = maxAnchorCount;
        for (let poll = 0; poll < 6; poll++) {
          await page.waitForTimeout(250);
          afterCount = await component.locator('a[href]').count().catch(() => afterCount);
          if (afterCount > maxAnchorCount) break;
        }

        if (afterCount > maxAnchorCount) maxAnchorCount = afterCount;
      }

      if (maxAnchorCount > beforeCount) {
        expandedCount++;
      }
    } catch (_) {
      // Keep extraction resilient when the component is absent, already expanded, or non-interactive.
    }
  }

  return expandedCount;
}

async function collectVisualPromoMapStateLinks(page, baseUrl, modeOverride = null) {
  const components = page.locator(VISUAL_PROMO_MAP_SELECTOR);
  const componentCount = await components.count().catch(() => 0);
  if (componentCount === 0) return [];

  let mergedLinks = [];

  for (let index = 0; index < componentCount; index++) {
    const component = components.nth(index);

    try {
      await component.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(150);

      const triggers = component.locator(VISUAL_PROMO_MAP_TRIGGER_SELECTOR);
      const triggerCount = await triggers.count().catch(() => 0);
      if (triggerCount === 0) continue;

      for (let triggerIndex = 0; triggerIndex < triggerCount; triggerIndex++) {
        const trigger = triggers.nth(triggerIndex);
        if (!(await trigger.isVisible().catch(() => false))) continue;

        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(100);
        await trigger.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(700);

        const stateLinks = await extractLinks(page, baseUrl, modeOverride);
        mergedLinks = mergeLinkArrays(mergedLinks, stateLinks);
      }
    } catch (_) {
      // Keep extraction resilient when visual promo markup varies between pages.
    }
  }

  return mergedLinks;
}

async function collectVisualPromoMapExpectedLinks(page) {
  const components = page.locator(VISUAL_PROMO_MAP_SELECTOR);
  const componentCount = await components.count().catch(() => 0);
  if (componentCount === 0) return [];

  let mergedExpectedLinks = [];

  for (let index = 0; index < componentCount; index++) {
    const component = components.nth(index);

    try {
      await component.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(150);

      const triggers = component.locator(VISUAL_PROMO_MAP_TRIGGER_SELECTOR);
      const triggerCount = await triggers.count().catch(() => 0);
      if (triggerCount === 0) continue;

      for (let triggerIndex = 0; triggerIndex < triggerCount; triggerIndex++) {
        const trigger = triggers.nth(triggerIndex);
        if (!(await trigger.isVisible().catch(() => false))) continue;

        await trigger.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(100);
        await trigger.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(700);

        const stateExpectedLinks = await extractExpectedLinks(page);
        mergedExpectedLinks = mergeExpectedLinkArrays(mergedExpectedLinks, stateExpectedLinks);
      }
    } catch (_) {
      // Keep expected-link detection resilient when visual promo markup varies between pages.
    }
  }

  mergedExpectedLinks._expectedCount = mergedExpectedLinks.length;
  return mergedExpectedLinks;
}

async function expandStickyCtaLinks(page) {
  const components = page.locator(STICKY_CTA_SELECTOR);
  const componentCount = await components.count().catch(() => 0);
  if (componentCount === 0) return 0;

  let expandedCount = 0;

  for (let index = 0; index < componentCount; index++) {
    const component = components.nth(index);

    try {
      // Sticky CTA variants often activate only after actual page scroll,
      // not from local element scrolling. Sweep a few scroll depths first.
      for (const ratio of [0.25, 0.5, 0.75]) {
        await page.evaluate((scrollRatio) => {
          const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          window.scrollTo(0, Math.floor(maxScroll * scrollRatio));
        }, ratio).catch(() => {});
        await page.waitForTimeout(250);
      }

      await component.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(150);

      const beforeCount = await component.locator('a[href]').count().catch(() => 0);
      const primaryTrigger = component.locator('bolt-button#stickyCtaButton');
      const fallbackTrigger = component.locator(STICKY_CTA_TRIGGER_SELECTOR).first();
      const primaryCount = await primaryTrigger.count().catch(() => 0);
      const trigger = primaryCount > 0 ? primaryTrigger.first() : fallbackTrigger;
      const triggerCount = primaryCount > 0 ? primaryCount : await component.locator(STICKY_CTA_TRIGGER_SELECTOR).count().catch(() => 0);
      if (triggerCount === 0) continue;

      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(100);
      await trigger.click({ force: true, timeout: 3000 }).catch(() => {});

      let afterCount = beforeCount;
      for (let poll = 0; poll < 6; poll++) {
        await page.waitForTimeout(250);
        afterCount = await component.locator('a[href]').count().catch(() => afterCount);
        if (afterCount > beforeCount) break;
      }

      if (afterCount > beforeCount) {
        expandedCount++;
      }
    } catch (_) {
      // Keep extraction resilient when sticky CTA markup varies between pages.
    }
  }

  return expandedCount;
}

async function collectStickyCtaStateLinks(page, baseUrl, modeOverride = null) {
  const components = page.locator(STICKY_CTA_SELECTOR);
  const componentCount = await components.count().catch(() => 0);
  if (componentCount === 0) return [];

  let mergedLinks = [];

  for (let index = 0; index < componentCount; index++) {
    const component = components.nth(index);

    try {
      for (const ratio of [0.25, 0.5, 0.75]) {
        await page.evaluate((scrollRatio) => {
          const maxScroll = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          window.scrollTo(0, Math.floor(maxScroll * scrollRatio));
        }, ratio).catch(() => {});
        await page.waitForTimeout(250);
      }

      const primaryTrigger = component.locator('bolt-button#stickyCtaButton');
      const fallbackTrigger = component.locator(STICKY_CTA_TRIGGER_SELECTOR).first();
      const primaryCount = await primaryTrigger.count().catch(() => 0);
      const trigger = primaryCount > 0 ? primaryTrigger.first() : fallbackTrigger;
      const triggerCount = primaryCount > 0 ? primaryCount : await component.locator(STICKY_CTA_TRIGGER_SELECTOR).count().catch(() => 0);
      if (triggerCount === 0) continue;

      await trigger.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1200);

      const stickyLinks = await component.evaluate((el) => {
        return Array.from(el.querySelectorAll('a[href]')).map((anchor) => {
          const text = (
            anchor.textContent?.trim() ||
            anchor.getAttribute('aria-label') ||
            anchor.getAttribute('title') ||
            'Unnamed link'
          ).replace(/\s+/g, ' ').substring(0, 100);

          return {
            href: anchor.href || anchor.getAttribute('href') || '',
            rawHref: anchor.getAttribute('href') || '',
            text,
            target: anchor.getAttribute('target') || '',
            outerHtml: anchor.outerHTML.substring(0, 200),
            elementType: 'HTML link',
            angularClassification: 'standard',
            hasNgxWrapper: false,
            hasSpecialAttrs: false,
            specialAttrNames: [],
            isRichText: false
          };
        });
      }).catch(() => []);

      const stateLinks = await extractLinks(page, baseUrl, modeOverride);
      mergedLinks = mergeLinkArrays(mergeLinkArrays(mergedLinks, stickyLinks), stateLinks);
    } catch (_) {
      // Keep extraction resilient when sticky CTA markup varies between pages.
    }
  }

  return mergedLinks;
}

async function expandAccordionLinks(page) {
  const items = page.locator(ACCORDION_ITEM_SELECTOR);
  const itemCount = await items.count().catch(() => 0);
  if (itemCount === 0) return 0;

  let expandedCount = 0;

  for (let index = 0; index < itemCount; index++) {
    const item = items.nth(index);

    try {
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(80);

      const trigger = item.locator(ACCORDION_TRIGGER_SELECTOR).first();
      if (!(await trigger.isVisible().catch(() => false))) continue;

      const itemClass = ((await item.getAttribute('class').catch(() => '')) || '').toLowerCase();
      const ariaExpanded = ((await trigger.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
      const isExpanded = itemClass.includes('is-active') || ariaExpanded === 'true';
      if (isExpanded) continue;

      await trigger.click({ force: true, timeout: 3000 });
      await page.waitForTimeout(250);

      const updatedClass = ((await item.getAttribute('class').catch(() => '')) || '').toLowerCase();
      const updatedAria = ((await trigger.getAttribute('aria-expanded').catch(() => '')) || '').toLowerCase();
      if (updatedClass.includes('is-active') || updatedAria === 'true') {
        expandedCount++;
      }
    } catch (_) {
      // Keep extraction resilient when accordion markup varies between pages.
    }
  }

  return expandedCount;
}

async function collectAccordionStateLinks(page, baseUrl, modeOverride = null) {
  const items = page.locator(ACCORDION_ITEM_SELECTOR);
  const itemCount = await items.count().catch(() => 0);
  if (itemCount === 0) return [];

  let mergedLinks = [];

  for (let index = 0; index < itemCount; index++) {
    const item = items.nth(index);

    try {
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(80);

      const trigger = item.locator(ACCORDION_TRIGGER_SELECTOR).first();
      if (!(await trigger.isVisible().catch(() => false))) continue;

      await trigger.click({ force: true, timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(350);

      const stateLinks = await extractLinks(page, baseUrl, modeOverride);
      mergedLinks = mergeLinkArrays(mergedLinks, stateLinks);
    } catch (_) {
      // Keep extraction resilient when accordion markup varies between pages.
    }
  }

  return mergedLinks;
}

async function extractUnifiedLinksStabilized(context, desktopPage, baseUrl) {
  let mergedLinks = [];
  let mergedMetadata = {
    _excludedCount: 0,
    _containerFound: 0,
    _responsiveHiddenCount: 0,
    _selectExpandedCount: 0,
    _promoMapExpandedCount: 0,
    _stickyCtaExpandedCount: 0,
    _accordionExpandedCount: 0
  };

  for (let pass = 1; pass <= STABILIZATION_PASSES; pass++) {
    if (pass > 1) {
      await desktopPage.waitForTimeout(STABILIZATION_DELAY_MS);
    }

    mergedMetadata._promoMapExpandedCount += await expandVisualPromoMapLinks(desktopPage);
    mergedMetadata._stickyCtaExpandedCount += await expandStickyCtaLinks(desktopPage);
    mergedMetadata._accordionExpandedCount += await expandAccordionLinks(desktopPage);

    const desktopLinks = await extractLinks(desktopPage, baseUrl, false);
    const desktopVisualPromoLinks = await collectVisualPromoMapStateLinks(desktopPage, baseUrl, false);
    const desktopStickyLinks = await collectStickyCtaStateLinks(desktopPage, baseUrl, false);
    const desktopAccordionLinks = await collectAccordionStateLinks(desktopPage, baseUrl, false);
    let mobileLinks = [];
    let mobileVisualPromoLinks = [];
    let mobileStickyLinks = [];
    let mobileAccordionLinks = [];
    let mobilePage;

    try {
      mobilePage = await context.newPage();
      await mobilePage.setViewportSize(MOBILE_VIEWPORT);
      await retryWrapper(async () => {
        await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForPageLoad(mobilePage);
      });
      mergedMetadata._promoMapExpandedCount += await expandVisualPromoMapLinks(mobilePage);
      mergedMetadata._stickyCtaExpandedCount += await expandStickyCtaLinks(mobilePage);
      mergedMetadata._accordionExpandedCount += await expandAccordionLinks(mobilePage);
      mobileLinks = await extractLinks(mobilePage, baseUrl, true);
      mobileVisualPromoLinks = await collectVisualPromoMapStateLinks(mobilePage, baseUrl, true);
      mobileStickyLinks = await collectStickyCtaStateLinks(mobilePage, baseUrl, true);
      mobileAccordionLinks = await collectAccordionStateLinks(mobilePage, baseUrl, true);
    } catch (mobileErr) {
      console.log(`   ⚠️ Unified mobile extraction pass ${pass} failed (desktop links still kept): ${mobileErr.message}`);
    } finally {
      if (mobilePage) await mobilePage.close().catch(() => {});
    }

    const desktopCombined = mergeLinkArrays(mergeLinkArrays(mergeLinkArrays(desktopLinks, desktopVisualPromoLinks), desktopStickyLinks), desktopAccordionLinks);
    const mobileCombined = mergeLinkArrays(mergeLinkArrays(mergeLinkArrays(mobileLinks, mobileVisualPromoLinks), mobileStickyLinks), mobileAccordionLinks);
    const desktopTagged = desktopCombined.map(link => ({ ...link, viewportSource: 'Desktop' }));
    const mobileTagged = mobileCombined.map(link => ({ ...link, viewportSource: 'Mobile Only' }));
    const passMerged = mergeLinkArrays(desktopTagged, mobileTagged);

    mergedLinks = mergeLinkArrays(mergedLinks, passMerged);
    mergedMetadata._excludedCount = Math.max(mergedMetadata._excludedCount, desktopLinks._excludedCount || 0);
    mergedMetadata._containerFound = Math.max(mergedMetadata._containerFound, desktopLinks._containerFound || 0);
    mergedMetadata._responsiveHiddenCount = Math.max(mergedMetadata._responsiveHiddenCount, desktopLinks._responsiveHiddenCount || 0);
    mergedMetadata._selectExpandedCount += (desktopLinks._selectExpandedCount || 0) + (mobileLinks._selectExpandedCount || 0);

    console.log(`   🔁 Stabilization pass ${pass}/${STABILIZATION_PASSES}: desktop=${desktopCombined.length}, mobile=${mobileCombined.length}, cumulative=${mergedLinks.length}`);
  }

  mergedLinks._excludedCount = mergedMetadata._excludedCount;
  mergedLinks._containerFound = mergedMetadata._containerFound;
  mergedLinks._responsiveHiddenCount = mergedMetadata._responsiveHiddenCount;
  mergedLinks._selectExpandedCount = mergedMetadata._selectExpandedCount;
  mergedLinks._promoMapExpandedCount = mergedMetadata._promoMapExpandedCount;
  mergedLinks._stickyCtaExpandedCount = mergedMetadata._stickyCtaExpandedCount;
  mergedLinks._accordionExpandedCount = mergedMetadata._accordionExpandedCount;

  return mergedLinks;
}

async function extractLinksStabilized(page, baseUrl) {
  let mergedLinks = [];
  let mergedMetadata = {
    _excludedCount: 0,
    _containerFound: 0,
    _responsiveHiddenCount: 0,
    _selectExpandedCount: 0,
    _promoMapExpandedCount: 0,
    _stickyCtaExpandedCount: 0,
    _accordionExpandedCount: 0
  };

  for (let pass = 1; pass <= STABILIZATION_PASSES; pass++) {
    if (pass > 1) {
      await page.waitForTimeout(STABILIZATION_DELAY_MS);
    }

    mergedMetadata._promoMapExpandedCount += await expandVisualPromoMapLinks(page);
    mergedMetadata._stickyCtaExpandedCount += await expandStickyCtaLinks(page);
    mergedMetadata._accordionExpandedCount += await expandAccordionLinks(page);

    const extracted = await extractLinks(page, baseUrl);
    const visualPromoLinks = await collectVisualPromoMapStateLinks(page, baseUrl);
    const stickyCtaLinks = await collectStickyCtaStateLinks(page, baseUrl);
    const accordionLinks = await collectAccordionStateLinks(page, baseUrl);
    const passLinks = mergeLinkArrays(mergeLinkArrays(mergeLinkArrays(extracted, visualPromoLinks), stickyCtaLinks), accordionLinks);
    mergedLinks = mergeLinkArrays(mergedLinks, passLinks);
    mergedMetadata._excludedCount = Math.max(mergedMetadata._excludedCount, extracted._excludedCount || 0);
    mergedMetadata._containerFound = Math.max(mergedMetadata._containerFound, extracted._containerFound || 0);
    mergedMetadata._responsiveHiddenCount = Math.max(mergedMetadata._responsiveHiddenCount, extracted._responsiveHiddenCount || 0);
    mergedMetadata._selectExpandedCount += extracted._selectExpandedCount || 0;

    console.log(`   🔁 Stabilization pass ${pass}/${STABILIZATION_PASSES}: extracted=${passLinks.length}, cumulative=${mergedLinks.length}`);
  }

  mergedLinks._excludedCount = mergedMetadata._excludedCount;
  mergedLinks._containerFound = mergedMetadata._containerFound;
  mergedLinks._responsiveHiddenCount = mergedMetadata._responsiveHiddenCount;
  mergedLinks._selectExpandedCount = mergedMetadata._selectExpandedCount;
  mergedLinks._promoMapExpandedCount = mergedMetadata._promoMapExpandedCount;
  mergedLinks._stickyCtaExpandedCount = mergedMetadata._stickyCtaExpandedCount;
  mergedLinks._accordionExpandedCount = mergedMetadata._accordionExpandedCount;

  return mergedLinks;
}

// ==================== EXCLUDED LINKS CONFIGURATION ====================
// Links matching these patterns will be skipped from the report
const EXCLUDED_PROTOCOLS = ['tel:', 'mailto:', 'sms:', 'fax:']; // Non-navigational protocols
const EXCLUDED_LINK_TEXT_PATTERNS = [
  'skip to main content',
  'skip to content',
  'skip navigation',
  'go to main content'
]; // Case-insensitive text patterns to exclude

// ==================== ANGULAR NGX-WEB-LINK CONFIGURATION ====================
// Angular environment URLs detection pattern
// Pattern: ngx-web-link wrapper with optional special attributes marking broken/exception links
const NGX_WEB_LINK_WRAPPER_SELECTOR = '.ngx-web-link';
const NGX_SPECIAL_ATTRIBUTES = [
  'data-broken-link',
  'data-intentional-break',
  'data-link-exception',
  'data-content-exception',
  'aria-disabled'
]; // Attributes indicating broken or intentionally handled links
const RICH_TEXT_COMPONENT_SELECTORS = [
  '[appRichText]',              // Angular directive for rich text
  '[ngComponentOutlet]',        // Dynamic component rendering (without * since it's not valid in selectors)
  'app-rich-text-content',      // Custom rich text component
  'app-cms-content',            // CMS content component
  '[data-rich-text="true"]'     // Data attribute marker
];

/**
 * Check if a link should be excluded from the report
 * Returns true if the link matches any exclusion criteria (href or text)
 */
function shouldExcludeFromReport(href, linkText) {
  if (REPORT_ALL_MODE) return false;
  if (!href) return false;
  
  const lowerHref = href.toLowerCase().trim();
  const lowerText = (linkText || '').toLowerCase().trim();

  // Check if href starts with excluded protocol
  for (const protocol of EXCLUDED_PROTOCOLS) {
    if (lowerHref.startsWith(protocol)) {
      return true;
    }
  }

  // Check if link text matches excluded patterns
  for (const pattern of EXCLUDED_LINK_TEXT_PATTERNS) {
    if (lowerText.includes(pattern)) {
      return true;
    }
  }

  return false;
}

// ==================== ANGULAR NGX-WEB-LINK HELPER FUNCTIONS ====================

/**
 * Detect Angular ngx-web-link wrapper pattern and classify link validation behavior.
 * 
 * Classification logic:
 *   1. ngx-web-link present WITHOUT special attributes → ✅ Valid link (validate normally)
 *   2. ngx-web-link present WITH special attributes → ⚠️ Broken/Exception link (mark as INFO/EXPECTED)
 *   3. No ngx-web-link + Rich Text component → ✅ Valid content-managed link (expected exception)
 * 
 * Returns: { hasWrapper, hasSpecialAttrs, isRichTextLink, classification }
 */
function detectNgxWebLinkPattern(element, ngxSelector, specialAttrs, richTextSelectors) {
  if (!element) return { hasWrapper: false, hasSpecialAttrs: false, isRichTextLink: false, classification: 'standard' };

  // Check for ngx-web-link wrapper (with error handling)
  let hasWrapper = false;
  try {
    hasWrapper = element.closest(ngxSelector) !== null;
  } catch (e) {
    hasWrapper = false;
  }
  
  // Check for special exception attributes if wrapper exists
  let hasSpecialAttrs = false;
  if (hasWrapper) {
    try {
      const wrapper = element.closest(ngxSelector);
      hasSpecialAttrs = specialAttrs.some(attr => wrapper.hasAttribute(attr));
    } catch (e) {
      hasSpecialAttrs = false;
    }
  }

  // Check if inside rich text component (with error handling for each selector)
  let isRichTextLink = false;
  for (const richTextSelector of richTextSelectors) {
    try {
      if (element.closest(richTextSelector)) {
        isRichTextLink = true;
        break;
      }
    } catch (e) {
      // Invalid selector - continue to next one
      continue;
    }
  }

  // Determine classification based on pattern
  let classification = 'standard';
  if (hasWrapper && !hasSpecialAttrs) {
    classification = 'angular-valid';  // ✅ ngx-web-link without exceptions
  } else if (hasWrapper && hasSpecialAttrs) {
    classification = 'angular-exception';  // ⚠️ ngx-web-link with special attributes
  } else if (!hasWrapper && isRichTextLink) {
    classification = 'rich-text-content';  // ✅ Content-managed link
  }

  return {
    hasWrapper,
    hasSpecialAttrs,
    isRichTextLink,
    classification
  };
}

/**
 * Validate that links follow the expected ngx-web-link wrapping pattern.
 * 
 * Expected patterns:
 *   1. Regular links → MUST have ngx-web-link wrapper, NO special attributes
 *   2. Exception links → MUST have ngx-web-link wrapper, WITH special attributes
 *   3. Rich text links → MUST NOT have ngx-web-link wrapper
 * 
 * Returns: { isValid, violations, message }
 */
function validateAngularLinkPattern(link) {
  // Skip validation for non-standard classification
  if (link.angularClassification === 'standard') {
    return { isValid: true, violations: [], message: 'Not an Angular pattern link' };
  }

  const violations = [];

  if (link.angularClassification === 'angular-valid') {
    // Expected: MUST have wrapper, NO special attributes
    if (!link.hasNgxWrapper) {
      violations.push('🚨 Regular Angular link MISSING ngx-web-link wrapper (REQUIRED)');
    }
    if (link.hasSpecialAttrs) {
      violations.push('⚠️ Regular Angular link SHOULD NOT have special attributes (expected none)');
    }
  } 
  else if (link.angularClassification === 'angular-exception') {
    // Expected: MUST have wrapper, MUST have special attributes
    if (!link.hasNgxWrapper) {
      violations.push('🚨 Exception link MISSING ngx-web-link wrapper (REQUIRED)');
    }
    if (!link.hasSpecialAttrs) {
      violations.push('🚨 Exception link MISSING special attributes (REQUIRED to be marked exception)');
    }
  } 
  else if (link.angularClassification === 'rich-text-content') {
    // Expected: MUST NOT have wrapper (content-managed)
    if (link.hasNgxWrapper) {
      violations.push('⚠️ Rich text link SHOULD NOT have ngx-web-link wrapper (content-managed)');
    }
  }

  return {
    isValid: violations.length === 0,
    violations,
    message: violations.length === 0 ? 'Pattern matches expectations' : violations.join(' | ')
  };
}


const results = [];
const urlSummaries = []; // Track summary stats per URL
let startTime, endTime;
let environmentName = 'Unknown';
// Tracks the viewport source for the link currently being validated;
// set before every logResult call so it is captured in the result object.
let _pendingViewportSource = 'N/A';
let _pendingSourceHref = 'N/A';
let _pendingSourceUrl = 'N/A';
let _pendingSourceComponent = 'N/A';
let _pendingSourceElement = 'N/A';
// Track pattern violations for reporting
let patternViolations = [];
 
/**
 * Escape text for HTML
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Remove ANSI escape codes from text
 */
function removeAnsiCodes(text) {
  if (!text) return '';
  // Remove ANSI escape codes like [2m, [22m, etc.
  return String(text).replace(/\x1b\[[0-9;]*m|\[\d+m/g, '');
}

function resolveSourceUrl(sourceHref, pageUrl) {
  if (!sourceHref || sourceHref === 'N/A') return 'N/A';
  const value = String(sourceHref).trim();
  if (!value || value === 'missing href' || value === 'empty href') return value || 'N/A';
  try {
    return new URL(value, pageUrl).href;
  } catch (_) {
    return value;
  }
}

/**
 * Truncate text to specified length
 */
function truncateText(text, maxLength = 50) {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}
 
// ==================== REPORTING ====================
 
/**
 * Log a step result
 */
function logResult(step, expected, actual, status, error = '', retryCount = 0, url = '', navigatedLink = '', linkType = 'N/A', statusCode = '', redirected = 'No', linkText = '', linkTarget = 'N/A', anchorIssue = 'No', elementType = 'N/A', angularClassification = 'standard', hasNgxWrapper = false, hasSpecialAttrs = false, isRichText = false) {
  results.push({
    step,
    expected,
    actual,
    status,
    error,
    retryCount,
    url,
    navigatedLink,
    linkType,
    statusCode,
    redirected,
    linkText,
    linkTarget,
    anchorIssue,
    elementType,
    sourceHref: _pendingSourceHref,
    sourceUrl: _pendingSourceUrl,
    sourceComponent: _pendingSourceComponent,
    sourceElement: _pendingSourceElement,
    viewportSource: _pendingViewportSource,  // 'Desktop' | 'Mobile Only' | 'Both' | 'N/A'
    // Angular ngx-web-link pattern classification
    angularClassification,
    hasNgxWrapper,
    hasSpecialAttrs,
    isRichText
  });
  const icon = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️' : status === 'INFO' ? 'ℹ️' : '❌';
  console.log(`${icon} ${step} - ${status} ${error ? `(${error})` : ''}`);
}
 
/**
 * Generate detailed HTML report for a single URL (only called for URLs with failures)
 */
function generateDetailedReport(urlResults, url, timestamp) {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  const reportFile = path.join(REPORT_DIR, `${sanitizedUrl}_Details_${timestamp}.html`);

  const totalSteps = urlResults.length;
  const passCount = urlResults.filter(r => r.status === 'PASS').length;
  const failCount = urlResults.filter(r => r.status === 'FAIL').length;
  const skipCount = urlResults.filter(r => r.status === 'SKIP').length;
  const infoCount = urlResults.filter(r => r.status === 'INFO').length;

  let rowCounter = 0;
  const rows = urlResults.map(r => {
    rowCounter++;
    
    let cleanError = r.error ? removeAnsiCodes(r.error) : '';
    const errorDisplay = cleanError && cleanError !== '-' 
      ? `<span class="error" title="${escapeHtml(cleanError)}">${escapeHtml(truncateText(cleanError, 100))}</span>` 
      : '-';
    
    const linkTextDisplay = r.linkText && r.linkText !== 'N/A' 
      ? (r.linkText.length > 40 ? `<span title="${escapeHtml(r.linkText)}">${escapeHtml(r.linkText.substring(0, 40))}...</span>` : escapeHtml(r.linkText))
      : escapeHtml(r.step.length > 40 ? r.step.substring(0, 40) + '...' : r.step);
    
    let cleanActual = removeAnsiCodes(r.actual);
    let actualDisplay = cleanActual;
    if (actualDisplay.includes('Error:') || actualDisplay.includes('FAIL')) {
      actualDisplay = truncateText(actualDisplay, 30);
    }
    actualDisplay = `<span title="${escapeHtml(cleanActual)}">${escapeHtml(actualDisplay)}</span>`;
    
    const linkTypeBadge = r.linkType === 'Internal' 
      ? '<span style="background: #10b981; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">Internal</span>'
      : r.linkType === 'External'
      ? '<span style="background: #f59e0b; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">External</span>'
      : '<span style="background: #6b7280; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">N/A</span>';
    
    const elementTypeColors = {
      'HTML link':                  { bg: '#2563eb', label: 'HTML link' },
      'JS link':                    { bg: '#d97706', label: 'JS link' },
      'Button link':                { bg: '#7c3aed', label: 'Button link' },
      'SPA router link':            { bg: '#0891b2', label: 'SPA router link' },
      'Expected Link':              { bg: '#ed6c02', label: '⚠️ Expected Link' },
      'Expected Link (A11Y Fail)':  { bg: '#c62828', label: '🚨 Expected Link (A11Y)' },
      'Span Broken Link':           { bg: '#b91c1c', label: '🔗❌ Span Broken Link' },
      'Missing Href':               { bg: '#78350f', label: '🔗 Missing Href' },
      'Bolt Tile Broken Link':      { bg: '#c2410c', label: '⚡❌ Bolt Tile Broken Link' }
    };
    const etInfo = elementTypeColors[r.elementType] || { bg: '#6b7280', label: r.elementType || 'N/A' };
    const elementTypeBadge = `<span style="background: ${etInfo.bg}; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">${etInfo.label}</span>`;
    
    const redirectedBadge = r.redirected === 'Yes'
      ? '<span style="background: #3b82f6; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">Yes</span>'
      : r.redirected === 'No'
      ? '<span style="background: #6b7280; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">No</span>'
      : '<span style="background: #6b7280; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">N/A</span>';
    
    const linkTargetBadge = r.linkTarget === 'New Window' 
      ? '<span style="background: #8b5cf6; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">New Window</span>'
      : r.linkTarget === 'Same Window'
      ? '<span style="background: #06b6d4; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">Same Window</span>'
      : `<span style="background: #6b7280; color: white; padding: 3px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">${r.linkTarget || 'N/A'}</span>`;
    
    const statusCodeDisplay = r.statusCode && r.statusCode !== 'N/A'
      ? `<strong style="color: ${parseInt(r.statusCode) >= 200 && parseInt(r.statusCode) < 300 ? '#10b981' : parseInt(r.statusCode) < 400 ? '#3b82f6' : '#ef4444'};">${escapeHtml(r.statusCode)}</strong>`
      : '-';
    
    let navigatedLinkDisplay = '-';
    if (r.navigatedLink) {
      navigatedLinkDisplay = `<a href="${escapeHtml(r.navigatedLink)}" target="_blank" title="${escapeHtml(r.navigatedLink)}">${escapeHtml(r.navigatedLink)}</a>`;
    }
    
    return `
    <tr>
      <td><strong>${rowCounter}</strong></td>
      <td>${linkTextDisplay}</td>
      <td>${linkTypeBadge}</td>
      <td data-element-type="${r.elementType || ''}">${elementTypeBadge}</td>
      <td>${linkTargetBadge}</td>
      <td>${escapeHtml(r.expected)}</td>
      <td>${actualDisplay}</td>
      <td><span class="status-${r.status.toLowerCase()}">${r.status}</span></td>
      <td>${statusCodeDisplay}</td>
      <td>${redirectedBadge}</td>
      <td>${(() => {
        const vp = r.viewportSource || 'N/A';
        const vpColors = { 'Desktop': '#1565c0', 'Mobile Only': '#2e7d32', 'Both': '#6b21a8', 'N/A': '#6b7280' };
        const c = vpColors[vp] || '#6b7280';
        return `<span style="background:${c};color:white;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:600;">${vp}</span>`;
      })()}</td>
      <td>${errorDisplay}</td>
      <td><strong>${r.retryCount || 0}</strong></td>
      <td class="url-cell">${navigatedLinkDisplay}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Link Validation Details - ${escapeHtml(url)}</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; }
    .container { max-width: 98%; margin: 0 auto; background: white; border-radius: 15px; padding: 30px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    h1 { color: #1f2937; margin-bottom: 10px; font-size: 28px; }
    .info { color: #6b7280; margin-bottom: 25px; font-size: 14px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
    .summary-item { padding: 20px; border-radius: 12px; text-align: center; color: white; font-size: 14px; }
    .summary-item strong { display: block; font-size: 32px; margin-bottom: 8px; }
    .summary-total { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .summary-pass { background: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%); }
    .summary-fail { background: linear-gradient(135deg, #eb3349 0%, #f45c43 100%); }
    .summary-skip { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
    .summary-info { background: linear-gradient(135deg, #0891b2 0%, #06b6d4 100%); }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 13px; background: white; }
    th { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 10px; text-align: left; position: sticky; top: 0; z-index: 10; }
    td { padding: 12px 10px; border-bottom: 1px solid #e5e7eb; }
    tr:hover { background-color: #f9fafb; }
    .status-pass { color: #10b981; font-weight: bold; }
    .status-fail { color: #ef4444; font-weight: bold; }
    .status-skip { color: #8b5cf6; font-weight: bold; }
    .status-info { color: #0891b2; font-weight: bold; }
    .status-expected { color: #ed6c02; font-weight: bold; }
    .error { color: #dc2626; font-size: 12px; cursor: help; }
    .url-cell { max-width: 400px; word-wrap: break-word; font-size: 11px; }
    .url-cell a { color: #3b82f6; text-decoration: none; }
    .url-cell a:hover { text-decoration: underline; }
    .back-link { display: inline-block; margin-bottom: 20px; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 8px; }
    .back-link:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="container">
    <a href="${environmentName}_Link_Validator_Summary_${timestamp}.html" class="back-link">← Back to Summary</a>
    <h1>🔗 Link Validation Details</h1>
    <p class="info">📅 Generated: ${new Date().toLocaleString()} | URL: <strong>${escapeHtml(url)}</strong></p>

    <div class="summary">
      <div class="summary-item summary-total">
        <strong>${totalSteps}</strong>
        Total Links Tested
      </div>
      <div class="summary-item summary-pass">
        <strong>${passCount}</strong>
        Passed
      </div>
      <div class="summary-item summary-fail">
        <strong>${failCount}</strong>
        Failed
      </div>
      <div class="summary-item summary-skip">
        <strong>${skipCount}</strong>
        Skipped
      </div>
      <div class="summary-item summary-info">
        <strong>${infoCount}</strong>
        Non-Href Clickable
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Link Text</th>
          <th>Type</th>
          <th>Element Type</th>
          <th>Target</th>
          <th>Expected</th>
          <th>Actual</th>
          <th>Status</th>
          <th>Code</th>
          <th>Redirect</th>
          <th>Viewport</th>
          <th>Error</th>
          <th>Retries</th>
          <th>Link URL</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;

  fs.writeFileSync(reportFile, html, 'utf-8');
  return reportFile;
}

/**
 * Generate summary dashboard HTML report
 */
function generateSummaryDashboard(urlSummaries, timestamp) {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const reportFile = path.join(REPORT_DIR, `${environmentName}_Link_Validator_Summary_${timestamp}.html`);

  const totalUrls = urlSummaries.length;
  const totalLinks = urlSummaries.reduce((sum, u) => sum + u.total, 0);
  const totalPass = urlSummaries.reduce((sum, u) => sum + u.passed, 0);
  const totalFail = urlSummaries.reduce((sum, u) => sum + u.failed, 0);
  const totalSkip = urlSummaries.reduce((sum, u) => sum + u.skipped, 0);
  const totalInfo = urlSummaries.reduce((sum, u) => sum + (u.info || 0), 0);
 
  const rows = urlSummaries.map((summary, index) => {
    const statusClass = summary.failed > 0 ? 'status-fail' : 'status-pass';
    const statusIcon = summary.failed > 0 ? '❌' : '✅';
    const detailsLink = summary.detailsReport 
      ? `<a href="${path.basename(summary.detailsReport)}" class="details-btn">View Details</a>`
      : '<span style="color: #9ca3af;">No failures</span>';
    
    return `
    <tr class="${statusClass}">
      <td><strong>${index + 1}</strong></td>
      <td class="url-cell"><a href="${escapeHtml(summary.url)}" target="_blank" title="${escapeHtml(summary.url)}">${escapeHtml(truncateText(summary.url, 80))}</a></td>
      <td><strong>${summary.total}</strong></td>
      <td style="color: #10b981;"><strong>${summary.passed}</strong></td>
      <td style="color: #ef4444;"><strong>${summary.failed}</strong></td>
      <td style="color: #8b5cf6;"><strong>${summary.skipped}</strong></td>
      <td style="color: #0891b2;"><strong>${summary.info || 0}</strong></td>
      <td><span class="${statusClass}">${statusIcon} ${summary.failed > 0 ? 'FAILED' : 'PASSED'}</span></td>
      <td>${detailsLink}</td>
    </tr>`;

  }).join('');
 
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Link Validation Summary - ${environmentName}</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      margin: 0; 
      padding: 20px; 
      background: #f5f7fa; 
      font-size: 15px;
    }
    .container { 
      max-width: 1400px; 
      margin: 0 auto; 
      background: white; 
      padding: 30px; 
      border-radius: 8px; 
      box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
    }
    h1 { 
      color: #2c3e50; 
      margin-bottom: 10px;
      font-size: 28px;
    }
    .info { 
      color: #7f8c8d; 
      margin-bottom: 20px; 
      font-size: 14px;
    }
    .summary { 
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px; 
      margin: 25px 0; 
    }
    .summary-item { 
      padding: 20px; 
      border-radius: 6px; 
      color: white; 
      text-align: center;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    }
    .summary-item strong { 
      display: block; 
      font-size: 32px; 
      margin-bottom: 5px;
    }
    .summary-total { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .summary-pass { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); }
    .summary-fail { background: linear-gradient(135deg, #eb3349 0%, #f45c43 100%); }
    .summary-skip { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
    .summary-info { background: linear-gradient(135deg, #0891b2 0%, #06b6d4 100%); }
    
    .table-wrapper {
      overflow-x: auto;
      margin-top: 25px;
      border: 1px solid #ddd;
      border-radius: 6px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    table { 
      width: 100%; 
      border-collapse: collapse; 
      font-size: 14px;
      min-width: 1200px;
      table-layout: auto;
    }
    thead {
      position: sticky;
      top: 0;
      z-index: 10;
    }
    th { 
      background: #34495e; 
      color: white; 
      padding: 14px 10px; 
      text-align: left;
      font-weight: 600;
      white-space: nowrap;
      border-bottom: 3px solid #2c3e50;
    }
    th:nth-child(1) { width: 60px; text-align: center; } /* # */
    th:nth-child(2) { width: 400px; } /* URL */
    th:nth-child(3) { width: 100px; text-align: center; } /* Total Links */
    th:nth-child(4) { width: 100px; text-align: center; } /* Passed */
    th:nth-child(5) { width: 100px; text-align: center; } /* Failed */
    th:nth-child(6) { width: 100px; text-align: center; } /* Skipped */
    th:nth-child(7) { width: 120px; text-align: center; } /* Status */
    th:nth-child(8) { width: 150px; text-align: center; } /* Details Link */
    
    tbody tr:nth-child(even) { 
      background: #f9fafb; 
    }
    tbody tr:hover { 
      background: #e8f4f8; 
      transition: background 0.2s;
    }
    td { 
      padding: 12px 10px; 
      border-bottom: 1px solid #e5e7eb;
      vertical-align: middle;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    td:nth-child(1), td:nth-child(3), td:nth-child(4), td:nth-child(5), td:nth-child(6), td:nth-child(7), td:nth-child(8) { 
      text-align: center; 
    }
    td:nth-child(2) {
      word-break: break-word;
      hyphens: auto;
    }
    
    .status-pass { 
      color: #fff;
      background: #10b981;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 600;
      display: inline-block;
      font-size: 12px;
    }
    .status-fail { 
      color: #fff;
      background: #ef4444;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 600;
      display: inline-block;
      font-size: 12px;
    }
    .status-skip { 
      color: #fff;
      background: #f59e0b;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 600;
      display: inline-block;
      font-size: 12px;
    }
    .status-info {
      color: #fff;
      background: #0891b2;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 600;
      display: inline-block;
      font-size: 12px;
    }
    
    .error { 
      color: #dc2626; 
      font-size: 12px; 
      word-break: break-word;
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.4;
    }
    
    .url-cell { 
      word-break: break-all; 
      font-size: 13px;
      line-height: 1.6;
    }
    .url-cell a { 
      color: #2563eb; 
      text-decoration: none;
      display: inline;
      overflow-wrap: break-word;
      word-wrap: break-word;
      font-weight: 500;
      background: #eff6ff;
      padding: 4px 8px;
      border-radius: 4px;
      border-left: 3px solid #2563eb;
    }
    .url-cell a:hover { 
      text-decoration: underline;
      color: #1d4ed8;
      background: #dbeafe;
    }
    
    .details-btn {
      background: #3b82f6;
      color: white;
      padding: 6px 16px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      display: inline-block;
      transition: background 0.2s;
    }
    .details-btn:hover {
      background: #2563eb;
    }
    
    .filter-container {
      margin: 20px 0;
      display: flex;
      gap: 10px;
      justify-content: center;
    }
    .filter-btn {
      padding: 10px 24px;
      border: 2px solid #e5e7eb;
      background: white;
      color: #374151;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .filter-btn:hover {
      border-color: #3b82f6;
      color: #3b82f6;
    }
    .filter-btn.active {
      background: #3b82f6;
      color: white;
      border-color: #3b82f6;
    }
    
    .footer { 
      margin-top: 30px; 
      padding-top: 20px;
      border-top: 2px solid #e5e7eb;
      color: #6b7280; 
      text-align: center; 
      font-size: 13px;
    }
    
    @media print {
      body { background: white; }
      .container { box-shadow: none; }
      .table-wrapper { overflow-x: visible; }
      table { min-width: auto; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>� Link Validation Summary Dashboard</h1>
    <p class="info">📅 Generated: ${new Date().toLocaleString()} | Environment: <strong>${environmentName}</strong></p>
 
    <div class="summary">
      <div class="summary-item summary-total">
        <strong>${totalUrls}</strong>
        URLs Tested
      </div>
      <div class="summary-item summary-total">
        <strong>${totalLinks}</strong>
        Total Links
      </div>
      <div class="summary-item summary-pass">
        <strong>${totalPass}</strong>
        Passed
      </div>
      <div class="summary-item summary-fail">
        <strong>${totalFail}</strong>
        Failed
      </div>
      <div class="summary-item summary-skip">
        <strong>${totalSkip}</strong>
        Skipped
      </div>
      <div class="summary-item summary-info">
        <strong>${totalInfo}</strong>
        Non-Href Clickable
      </div>
    </div>

    <div class="filter-container">
      <button class="filter-btn filter-all" onclick="filterRows('all')">Show All</button>
      <button class="filter-btn filter-failed" onclick="filterRows('fail')">Show Failed Only</button>
      <button class="filter-btn filter-passed" onclick="filterRows('pass')">Show Passed Only</button>
      <button class="filter-btn filter-info" onclick="filterRows('info')">Show Non-Href Only</button>
      <button class="filter-btn filter-expected" onclick="filterRows('expected')">Show Expected Links</button>
      <button class="filter-btn filter-missing-href" onclick="filterRows('missing-href')">Show Missing Href</button>
      <button class="filter-btn filter-bolt-tile" onclick="filterRows('bolt-tile')">Show Bolt Tile Issues</button>
    </div>
 
    <div class="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>URL</th>
            <th>Total Links</th>
            <th>Passed</th>
            <th>Failed</th>
            <th>Skipped</th>
            <th>Non-Href</th>
            <th>Status</th>
            <th>Details Link</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
 
    <div class="footer">
      <p><strong>⏱️ Execution Time:</strong> Started at ${startTime ? startTime.toLocaleString() : 'N/A'} | Ended at ${endTime ? endTime.toLocaleString() : 'N/A'}</p>
      <p>📊 Pass Rate: <strong>${totalLinks > 0 ? ((totalPass / totalLinks) * 100).toFixed(2) : 0}%</strong></p>
    </div>
  </div>
  
  <script>
    function filterRows(type) {
      const rows = document.querySelectorAll('tbody tr');
      const buttons = document.querySelectorAll('.filter-btn');
      
      // Update active button
      buttons.forEach(btn => btn.classList.remove('active'));
      if (type === 'all')      document.querySelector('.filter-all').classList.add('active');
      if (type === 'fail')     document.querySelector('.filter-failed').classList.add('active');
      if (type === 'pass')     document.querySelector('.filter-passed').classList.add('active');
      if (type === 'info')     document.querySelector('.filter-info').classList.add('active');
      if (type === 'expected')    document.querySelector('.filter-expected')     && document.querySelector('.filter-expected').classList.add('active');
      if (type === 'missing-href') document.querySelector('.filter-missing-href') && document.querySelector('.filter-missing-href').classList.add('active');
      if (type === 'bolt-tile')    document.querySelector('.filter-bolt-tile')    && document.querySelector('.filter-bolt-tile').classList.add('active');
      
      // Filter rows
      rows.forEach(row => {
        if (type === 'all') {
          row.style.display = '';
        } else if (type === 'fail') {
          row.style.display = row.classList.contains('status-fail') ? '' : 'none';
        } else if (type === 'pass') {
          row.style.display = row.classList.contains('status-pass') ? '' : 'none';
        } else if (type === 'info') {
          // Show non-href INFO rows (exclude Expected Link rows)
          const isInfo = row.classList.contains('status-info');
          const elementType = row.querySelector('td[data-element-type]')?.dataset?.elementType || '';
          const isExpected = elementType.includes('Expected Link');
          row.style.display = (isInfo && !isExpected) ? '' : 'none';
        } else if (type === 'expected') {
          // Show only rows where element type is Expected Link
          const elementType = row.querySelector('td[data-element-type]')?.dataset?.elementType || '';
          row.style.display = elementType.includes('Expected Link') ? '' : 'none';
        } else if (type === 'missing-href') {
          // Show only rows where element type is Missing Href (unannotated bare <a> tags)
          const elementType = row.querySelector('td[data-element-type]')?.dataset?.elementType || '';
          row.style.display = elementType.includes('Missing Href') ? '' : 'none';
        } else if (type === 'bolt-tile') {
          // Show only rows where element type is Bolt Tile Broken Link (href="/" placeholders)
          const elementType = row.querySelector('td[data-element-type]')?.dataset?.elementType || '';
          row.style.display = elementType.includes('Bolt Tile Broken Link') ? '' : 'none';
        }
      });
    }
    
    // Set default filter to "Show All"
    document.addEventListener('DOMContentLoaded', function() {
      document.querySelector('.filter-all').classList.add('active');
    });
  </script>
</body>
</html>`;
 
  fs.writeFileSync(reportFile, html);
  console.log(`\n📄 HTML report generated: ${reportFile}`);
}

/**
 * Generate combined HTML report (all URLs in one file with collapsible sections)
 */
function generateCombinedReport(allResults, timestamp) {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  const safeEnvironmentName = (environmentName || 'Unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const aggregatePrefix = environmentName === 'Combined'
    ? 'combined_link_validation'
    : `${safeEnvironmentName}_link_validation`;
  const reportFile = path.join(REPORT_DIR, `${aggregatePrefix}_${timestamp}.html`);

  // Group results by URL
  const groupedByUrl = {};
  allResults.forEach(r => {
    if (!groupedByUrl[r.url]) {
      groupedByUrl[r.url] = [];
    }
    groupedByUrl[r.url].push(r);
  });

  // Calculate overall statistics
  const overallStats = {
    total: allResults.length,
    ok: allResults.filter(r => r.status === 'PASS').length,
    broken: allResults.filter(r => r.status === 'FAIL').length,
    redirected: allResults.filter(r => r.redirected === 'Yes').length,
  };
  
  const clickablePercentage = overallStats.total > 0 
    ? ((overallStats.ok / overallStats.total) * 100).toFixed(1) 
    : 0;

  // Build details sections for each URL
  let detailsSections = '';
  Object.entries(groupedByUrl).forEach(([url, urlResults]) => {
    // Filter out N/A type results (like page navigation)
    const validResults = urlResults.filter(r => r.linkType !== 'N/A');
    
    const urlStats = {
      total: validResults.length,
      ok: validResults.filter(r => r.status === 'PASS').length,
      broken: validResults.filter(r => r.status === 'FAIL').length,
      redirected: validResults.filter(r => r.redirected === 'Yes').length,
    };

    const urlClickable = urlStats.total > 0 
      ? ((urlStats.ok / urlStats.total) * 100).toFixed(1)
      : 0;

    // Build table rows
    const rows = validResults.map(r => {
      const isOk = r.status === 'PASS';
      const isBroken = r.status === 'FAIL';
      const isRedirected = r.redirected === 'Yes';
      
      let rowClass = 'ok';
      if (isBroken) rowClass = 'broken';
      else if (isRedirected) rowClass = 'redirected';

      const statusDisplay = isBroken ? 'Fail' : 'Pass';
      const statusBadge = isBroken ? 'BROKEN' : 'OK';
      
      // Determine link type with anchor info
      let typeDisplay = r.linkType || 'N/A';
      let typeClass = typeDisplay.toLowerCase();
      if (r.navigatedLink && r.navigatedLink.includes('#')) {
        typeDisplay += ' (Anchor)';
        if (r.anchorIssue === 'Yes') {
          typeClass = 'anchor-broken';
        }
      }

      const statusCode = r.statusCode || 'N/A';
      const error = r.error && r.error !== '-' ? escapeHtml(r.error) : '';
      
      // Style error text red
      const errorDisplay = error ? `<span style="color:#c62828;font-weight:600;">${error}</span>` : '';

      const vpColors = { 'Desktop': '#1565c0', 'Mobile Only': '#2e7d32', 'Both': '#6b21a8' };
      const vpColor = vpColors[r.viewportSource] || '#6b7280';
      const vpBadge = r.viewportSource && r.viewportSource !== 'N/A'
        ? `<span style="background:${vpColor};color:white;padding:2px 7px;border-radius:10px;font-size:11px;">${r.viewportSource}</span>`
        : '';
      return `<tr class="${rowClass}">
        <td>${r.linkType || 'external'}</td>
        <td>${r.elementType || 'HTML link'}</td>
        <td>${escapeHtml(r.sourceHref || 'N/A')}</td>
        <td>${escapeHtml(r.sourceUrl || 'N/A')}</td>
        <td>${escapeHtml(r.sourceComponent || 'N/A')}</td>
        <td>${escapeHtml(r.sourceElement || 'N/A')}</td>
        <td><a href="${escapeHtml(r.navigatedLink)}" target="_blank" title="${escapeHtml(r.navigatedLink)}">${escapeHtml(r.navigatedLink)}</a></td>
        <td>${r.linkTarget || 'N/A'}</td>
        <td>${statusDisplay}</td>
        <td>${statusBadge}</td>
        <td>${statusCode}</td>
        <td>${r.redirected}</td>
        <td>${vpBadge}</td>
        <td>${escapeHtml(r.linkText)}</td>
        <td>${r.anchorIssue || 'No'}</td>
        <td>${errorDisplay}</td>
      </tr>`;
    }).join('\n');

    // Only add section if there are valid results
    if (validResults.length > 0) {
      detailsSections += `<details>
<summary>${escapeHtml(url)} — Total: ${urlStats.total} | OK: ${urlStats.ok} | Broken: ${urlStats.broken} | Redirected: ${urlStats.redirected} | Clickable %: ${urlClickable}%</summary>
<table>
<thead>
<tr>
<th>Type</th>
<th>Element Type</th>
<th>Source Href</th>
<th>Source URL</th>
<th>Source Component</th>
<th>Source Element</th>
<th>URL</th>
<th>Target</th>
<th>Test Result</th>
<th>Status</th>
<th>Status Code</th>
<th>Redirected</th>
<th>Viewport</th>
<th>Link Text</th>
<th>Anchor Issue</th>
<th>Error</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</details>`;
    }
  });

  const html = `<html><head><meta charset="utf-8"><title>Combined Link Validation Report (Playwright - JavaScript)</title><style>
        body{font-family:Segoe UI,Arial,sans-serif;margin:16px;}
        table{border-collapse:collapse;width:100%;margin:8px 0;}
        th,td{border:1px solid #ccc;padding:8px 10px;font-size:13px;}
        th{background:#f5f7fa;font-weight:600;}
        tr:nth-child(even){background:#f9f9f9;} tr:nth-child(odd){background:#fff;}
        details{margin:14px 0 18px;border:1px solid #bbb;padding:10px 14px;border-radius:8px;background:#fafafa;}
        summary{font-weight:700;font-size:15px;cursor:pointer;}
        .ok{color:#2e7d32;} .broken{color:#c62828;font-weight:600;} .redirected{color:#1565c0;}
        .pill{display:inline-block;padding:2px 10px;border-radius:12px;background:#e0e0e0;margin-right:8px;font-size:13px;}
        .pill-ok{background:#c8e6c9;} .pill-broken{background:#ffcdd2;} .pill-redirected{background:#bbdefb;}
        a{color:#1565c0;text-decoration:none;} a:hover{text-decoration:underline;}
    </style></head><body><h1>Combined Link Validation Report (Playwright - JavaScript)</h1><div>Generated: ${new Date().toLocaleString()}</div><div style="margin:10px 0;"><span class="pill pill-ok">OK: ${overallStats.ok}</span><span class="pill pill-broken">Broken: ${overallStats.broken}</span><span class="pill pill-redirected">Redirected: ${overallStats.redirected}</span><span class="pill">Total: ${overallStats.total}</span><span class="pill">Clickable %: ${clickablePercentage}%</span></div>${detailsSections}</body></html>`;

  fs.writeFileSync(reportFile, html, 'utf-8');
  console.log(`\n📄 Combined report generated: ${reportFile}`);
  return reportFile;
}

// ==================== PAGE ERROR MESSAGES (from error_validator.js) ====================
// Matches the full error message list used in error_validator.js
const PAGE_ERROR_MESSAGES = [
  // Application-specific
  "We can't find that page",
  "We apologize, fund performance is temporarily unavailable.",
  "A problem occurred while rendering this section.",
  "This site can't be reached",
  "Details for this policy are no longer available. Please return to the",
  "We Are Having Technical Difficulties",
  "Please first review the guidelines below and register to participate in using Generative AI websites",
  "No webpage was found for the web address",
  "Application Unavailable",
  // 404
  "404 Not Found", "404 \u2013 Not Found", "404 \u2014 Not Found", "Error 404",
  // 403
  "403 Forbidden", "403 \u2013 Forbidden", "403 \u2014 Forbidden", "Error 403",
  "Access Denied", "Access denied",
  // 401
  "401 Unauthorized", "401 \u2013 Unauthorized", "401 \u2014 Unauthorized",
  "Error 401", "Authentication required",
  // 429
  "429 Too Many Requests", "429 \u2013 Too Many Requests", "429 \u2014 Too Many Requests",
  "Error 429", "Rate limit exceeded", "Too Many Requests",
  // 500
  "500 Internal Server Error", "500 \u2013 Internal Server Error", "500 \u2014 Internal Server Error",
  "Error 500", "Internal Server Error",
  // 502
  "502 Bad Gateway", "502 \u2013 Bad Gateway", "502 \u2014 Bad Gateway", "Error 502",
  // 503
  "503 Service Unavailable", "503 \u2013 Service Unavailable", "503 \u2014 Service Unavailable",
  "Error 503", "Service Unavailable", "Service temporarily unavailable",
  // 504
  "504 Gateway Timeout", "504 \u2013 Gateway Timeout", "504 \u2014 Gateway Timeout",
  "Error 504", "Gateway Timeout"
];

const RATE_LIMIT_ERROR_MESSAGES = [
  "429 Too Many Requests",
  "Error 429",
  "Rate limit exceeded",
  "Too Many Requests"
];

function normalizeErrorText(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .toLowerCase();
}

function isRateLimitErrorMessage(message) {
  const normalizedMessage = normalizeErrorText(message);
  return RATE_LIMIT_ERROR_MESSAGES.some(pattern => normalizedMessage.includes(normalizeErrorText(pattern)));
}

/**
 * Detect page-level UI error messages on a Playwright page.
 * Mirrors checkPageSource + checkVisibleText + scanDomForRenderingError from error_validator.js.
 * Returns an array of unique error message strings found on the page.
 */
async function detectPageErrors(page) {
  const parts = []; // ordered result parts: title line, h1 line, extra errors
  try {
    // ── Strategy 1: Capture actual <title> and first visible <h1> ────────────
    // This surfaces the real text the page shows (e.g. "Error 404 (Not Found) – Nationwide"
    // and "We can't find that page") instead of generic pattern-matched strings.
    const { pageTitle, h1Text, domErrors: domExtra } = await page.evaluate((errorPatterns) => {
      // ── page <title> ──────────────────────────────────────────────────────
      const pageTitle = (document.title || '').trim();

      // ── first visible <h1> ────────────────────────────────────────────────
      let h1Text = '';
      const h1Els = document.querySelectorAll('h1');
      for (const el of h1Els) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const text = (el.textContent || el.innerText || '').trim();
        if (text) { h1Text = text; break; }
      }

      // ── DOM-aware extras (rendering error, fund-performance, bolt-notification) ──
      const domErrors = [];
      const renderingError = 'A problem occurred while rendering this section';
      const alertDivs = document.querySelectorAll('div.alert.alert-danger, [class*="error"][class*="alert"]');
      for (const div of alertDivs) {
        if ((div.textContent || '').includes(renderingError)) {
          domErrors.push('A problem occurred while rendering this section.');
          break;
        }
      }
      const fundMsg = 'We apologize, fund performance is temporarily unavailable.';
      const notifEls = document.querySelectorAll(
        'bolt-notification, nw-notification, [class*="notification"], ' +
        '[role="alert"], [class*="alert"], [class*="error"], [class*="warning"]'
      );
      for (const el of notifEls) {
        const text = el.textContent || el.innerText || '';
        if (text.includes(fundMsg)) {
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            domErrors.push(fundMsg);
            break;
          }
        }
      }

      return { pageTitle, h1Text, domErrors };
    }, PAGE_ERROR_MESSAGES);

    // ── Normalize smart/curly quotes → straight so patterns always match ────
    // e.g. page renders "We can\u2019t find that page" but pattern has "We can't find that page"
    const normalize = (str) => str
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // curly single quotes → '
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')   // curly double quotes → "
      .replace(/[\u2013\u2014]/g, '-');               // em/en dash → -

    const titleNorm = normalize(pageTitle);
    const h1Norm    = normalize(h1Text);

    // ── Check if the title or h1 match any known error pattern ────────────
    const titleMatches = PAGE_ERROR_MESSAGES.some(msg => titleNorm.includes(normalize(msg)));
    // If the title already confirmed an error page, always show the H1 (it IS the error message).
    // Also independently check the H1 text against patterns (handles pages without a matching title).
    const h1Matches = titleMatches || PAGE_ERROR_MESSAGES.some(msg => h1Norm.includes(normalize(msg)));

    // ── Strategy 2: visible body text fallback (catches messages not in title/h1) ──
    const visibleText = await page.evaluate(() => {
      function getVisibleText(el) {
        if (!el || el.nodeType !== 1) return '';
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
        let text = '';
        for (const child of el.childNodes) {
          if (child.nodeType === 3) text += child.textContent;
          else if (child.nodeType === 1) text += getVisibleText(child);
        }
        return text;
      }
      return getVisibleText(document.body);
    });
    const visibleTextNorm = normalize(visibleText);
    const bodyPatternMatches = PAGE_ERROR_MESSAGES.filter(msg => visibleTextNorm.includes(normalize(msg)));

    // ── Build the result string with real page content ─────────────────────
    // Priority: title → h1 → remaining body-pattern matches → DOM extras
    const seen = new Set();

    if (pageTitle && titleMatches) {
      parts.push(pageTitle);
      seen.add(normalize(pageTitle));
    }
    if (h1Text && h1Matches) {
      parts.push(h1Text);
      seen.add(normalize(h1Text));
    }

    // Include body-text pattern matches that aren't already represented by title/h1
    for (const msg of bodyPatternMatches) {
      // Skip if the matched pattern text is already covered by the captured title/h1
      const msgNorm = normalize(msg);
      const alreadyCovered = [...seen].some(s => s.includes(msgNorm) || msgNorm.includes(s));
      if (!alreadyCovered) {
        parts.push(msg);
        seen.add(msgNorm);
      }
    }

    // DOM extras (rendering error, fund-performance)
    for (const msg of domExtra) {
      const msgNorm = normalize(msg);
      if (![...seen].some(s => s.includes(msgNorm) || msgNorm.includes(s))) {
        parts.push(msg);
        seen.add(msgNorm);
      }
    }
  } catch (_) {
    // Non-fatal — return whatever was collected
  }
  return parts; // caller joins with ' | '
}

/**
 * Post-process the generated Excel file:
 *   1. Read "Status Fail" sheet
 *   2. Collect unique URLs from "Navigated Link" column
 *   3. Open each URL in Playwright and run detectPageErrors()
 *   4. Write results back as a new "Page Errors" column in the same sheet
 * Mirrors the error detection approach of error_validator.js.
 */
async function runErrorValidationOnFailSheet(xlsxFilePath) {
  try {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxFilePath);

    const failSheet = workbook.getWorksheet('Status Fail');
    if (!failSheet) {
      console.log('\nℹ️ "Status Fail" sheet not found — skipping page error validation.');
      return;
    }

    /**
     * Safely extract a plain-text string from an ExcelJS cell value.
     * ExcelJS can store URLs as { text, hyperlink } objects when it detects a hyperlink,
     * which would cause String(value) to return "[object Object]" if not handled.
     */
    function cellText(cell) {
      const val = cell.value;
      if (!val) return '';
      if (typeof val === 'string') return val.trim();
      // Hyperlink object: { text: '...', hyperlink: 'https://...' }
      if (typeof val === 'object' && val.hyperlink) return String(val.hyperlink).trim();
      if (typeof val === 'object' && val.text)      return String(val.text).trim();
      return String(val).trim();
    }

    // Find "Navigated Link" column index (1-based)
    const headerRow = failSheet.getRow(1);
    let navigatedLinkCol = 0;
    let lastHeaderCol   = 0;
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const hdr = cellText(cell);
      if (hdr === 'Navigated Link') navigatedLinkCol = colNumber;
      if (colNumber > lastHeaderCol) lastHeaderCol = colNumber;
    });
    if (!navigatedLinkCol) {
      console.log('\nℹ️ "Navigated Link" column not found — skipping page error validation.');
      return;
    }

    // Add "Page Errors" header in the column immediately after the last occupied header column
    const pageErrorsCol = lastHeaderCol + 1;
    const peHeader = headerRow.getCell(pageErrorsCol);
    peHeader.value = 'Page Errors';
    peHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC62828' } };
    peHeader.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    peHeader.alignment = { vertical: 'middle', horizontal: 'center' };
    peHeader.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    failSheet.getColumn(pageErrorsCol).width = 65;
    headerRow.height = 20;
    headerRow.commit();

    // Collect unique navigated-link URLs (skip header)
    const urlToRows = new Map(); // url -> [rowNumbers]
    failSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const navLink = cellText(row.getCell(navigatedLinkCol));
      if (navLink && navLink.startsWith('http')) {
        if (!urlToRows.has(navLink)) urlToRows.set(navLink, []);
        urlToRows.get(navLink).push(rowNumber);
      }
    });

    const uniqueUrls = [...urlToRows.keys()];
    if (uniqueUrls.length === 0) {
      console.log('\nℹ️ No valid URLs in "Navigated Link" column — nothing to validate.');
      await workbook.xlsx.writeFile(xlsxFilePath);
      return;
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`🔍 PAGE ERROR VALIDATION — ${uniqueUrls.length} unique failed URL(s)`);
    console.log(`${'═'.repeat(70)}`);

    // Launch a fresh Playwright browser for the error validation pass
    const errBrowser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled']
    });
    const errContext = await errBrowser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });

    const urlErrorMap = new Map(); // url -> result string

    for (let i = 0; i < uniqueUrls.length; i++) {
      const url = uniqueUrls[i];
      console.log(`\n   [${i + 1}/${uniqueUrls.length}] Checking: ${url}`);
      const errPage = await errContext.newPage();
      try {
        await errPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // Allow SPA/dynamic content to settle (mirrors error_validator.js stability wait)
        await errPage.waitForTimeout(3000);
        const errors = await detectPageErrors(errPage);
        if (errors.length > 0) {
          const joined = errors.join(' | ');
          urlErrorMap.set(url, joined);
          console.log(`   ❌ Page errors found: ${joined}`);
        } else {
          urlErrorMap.set(url, 'No page errors detected');
          console.log(`   ✅ No page errors detected`);
        }
      } catch (navErr) {
        const msg = `Navigation failed: ${navErr.message.substring(0, 120)}`;
        urlErrorMap.set(url, msg);
        console.log(`   ⚠️ ${msg}`);
      } finally {
        await errPage.close().catch(() => {});
      }
    }

    await errBrowser.close().catch(() => {});

    // Write results back into every matching row of the Status Fail sheet
    failSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const navLink = cellText(row.getCell(navigatedLinkCol));
      if (navLink && urlErrorMap.has(navLink)) {
        const errValue = urlErrorMap.get(navLink);
        const cell = row.getCell(pageErrorsCol);
        cell.value = errValue;
        cell.font = { size: 10 };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = { top: { style: 'hair' }, left: { style: 'hair' }, bottom: { style: 'hair' }, right: { style: 'hair' } };
        cell.fill = {
          type: 'pattern', pattern: 'solid',
          fgColor: { argb: errValue === 'No page errors detected' ? 'FFC8E6C9' : 'FFFFCDD2' }
        };
      }
      row.commit();
    });

    // Remove rows from Status Fail sheet where Page Errors = "No page errors detected"
    // These are false positives (link returned 4xx/5xx but page shows no error)
    const rowsToDelete = [];
    failSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const pageErrorValue = cellText(row.getCell(pageErrorsCol));
      if (pageErrorValue === 'No page errors detected') {
        rowsToDelete.push(rowNumber);
      }
    });

    // Delete rows in reverse order to maintain correct row numbers
    for (let i = rowsToDelete.length - 1; i >= 0; i--) {
      failSheet.spliceRows(rowsToDelete[i], 1);
    }

    if (rowsToDelete.length > 0) {
      console.log(`⏭️  Removed ${rowsToDelete.length} row(s) with "No page errors detected" from Status Fail sheet`);
    }

    await workbook.xlsx.writeFile(xlsxFilePath);
    console.log(`\n✅ "Page Errors" column written to "Status Fail" sheet: ${xlsxFilePath}`);
  } catch (err) {
    console.error(`⚠️ Post-process error validation failed: ${err.message}`);
  }
}

/**
 * Export results to CSV, JSON, and Excel (with All Results + Status Fail sheets)
 */
async function exportResults() {
  const timestamp = Date.now();

  // ── CSV ──────────────────────────────────────────────────────────────────
  const csvLines = [
    ['url', 'linkText', 'elementType', 'linkType', 'linkTarget', 'sourceHref', 'sourceUrl', 'sourceComponent', 'sourceElement', 'viewportSource', 'angularClassification', 'hasNgxWrapper', 'hasSpecialAttrs', 'isRichText', 'expected', 'actual', 'status', 'statusCode', 'redirected', 'anchorIssue', 'error', 'retryCount', 'navigatedLink'].join(',')
  ];
  for (const r of results) {
    csvLines.push([
      `"${(r.url || '').replace(/"/g, '""')}"`,
      `"${(r.linkText || '').replace(/"/g, '""')}"`,
      r.elementType || 'N/A',
      r.linkType || 'N/A',
      r.linkTarget || 'N/A',
      `"${(r.sourceHref || '').replace(/"/g, '""')}"`,
      `"${(r.sourceUrl || '').replace(/"/g, '""')}"`,
      `"${(r.sourceComponent || '').replace(/"/g, '""')}"`,
      `"${(r.sourceElement || '').replace(/"/g, '""')}"`,
      r.viewportSource || 'N/A',
      r.angularClassification || 'standard',
      r.hasNgxWrapper ? 'Yes' : 'No',
      r.hasSpecialAttrs ? 'Yes' : 'No',
      r.isRichText ? 'Yes' : 'No',
      `"${r.expected.replace(/"/g, '""')}"`,
      `"${r.actual.replace(/"/g, '""')}"`,
      r.status,
      r.statusCode || 'N/A',
      r.redirected || 'No',
      r.anchorIssue || 'No',
      `"${(r.error || '').replace(/"/g, '""')}"`,
      r.retryCount,
      `"${(r.navigatedLink || '').replace(/"/g, '""')}"`
    ].join(','));
  }
  fs.writeFileSync(path.join(REPORT_DIR, `${environmentName}_Link_Validator_${timestamp}.csv`), csvLines.join('\n'), 'utf-8');

  // ── JSON ─────────────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(REPORT_DIR, `${environmentName}_Link_Validator_${timestamp}.json`), JSON.stringify(results, null, 2), 'utf-8');

  // ── EXCEL ────────────────────────────────────────────────────────────────
  try {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Link Validator';
    workbook.created = new Date();

    const COLUMNS = [
      { header: 'Page URL',                 key: 'url',                    width: 50 },
      { header: 'Link Text',                key: 'linkText',               width: 35 },
      { header: 'Element Type',             key: 'elementType',            width: 16 },
      { header: 'Link Type',                key: 'linkType',               width: 12 },
      { header: 'Link Target',              key: 'linkTarget',             width: 14 },
      { header: 'Source Href',              key: 'sourceHref',             width: 35 },
      { header: 'Source URL',               key: 'sourceUrl',              width: 50 },
      { header: 'Source Component',         key: 'sourceComponent',        width: 45 },
      { header: 'Source Element',           key: 'sourceElement',          width: 35 },
      { header: 'Viewport',                 key: 'viewportSource',         width: 14 },
      { header: 'Angular Classification',   key: 'angularClassification',   width: 20 },
      { header: 'Has Ngx Wrapper',          key: 'hasNgxWrapper',          width: 16 },
      { header: 'Has Special Attrs',        key: 'hasSpecialAttrs',        width: 16 },
      { header: 'Is Rich Text',             key: 'isRichText',             width: 14 },
      { header: 'Expected',                 key: 'expected',               width: 18 },
      { header: 'Actual',                   key: 'actual',                 width: 18 },
      { header: 'Status',                   key: 'status',                 width: 10 },
      { header: 'Status Code',              key: 'statusCode',             width: 12 },
      { header: 'Redirected',               key: 'redirected',             width: 12 },
      { header: 'Anchor Issue',             key: 'anchorIssue',            width: 14 },
      { header: 'Error',                    key: 'error',                  width: 45 },
      { header: 'Retry Count',              key: 'retryCount',             width: 12 },
      { header: 'Navigated Link',           key: 'navigatedLink',          width: 50 }
    ];

    // Shared style helpers
    const headerFill = (color) => ({
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: color }
    });
    const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    const cellFont   = { size: 10 };

    const statusFills = {
      PASS: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } }, // light green
      FAIL: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } }, // light red
      SKIP: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } }  // light yellow
    };

    /**
     * Populate a worksheet with given rows.
     * @param {ExcelJS.Worksheet} sheet
     * @param {Object[]}          rows
     * @param {string}            headerColor  ARGB hex
     */
    function populateSheet(sheet, rows, headerColor) {
      sheet.columns = COLUMNS;

      // Style header row
      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell) => {
        cell.fill = headerFill(headerColor);
        cell.font = headerFont;
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
        cell.border = {
          top:    { style: 'thin' },
          left:   { style: 'thin' },
          bottom: { style: 'thin' },
          right:  { style: 'thin' }
        };
      });
      headerRow.height = 20;

      // Add data rows
      rows.forEach((r, idx) => {
        const row = sheet.addRow({
          url:                    r.url                    || '',
          linkText:               r.linkText               || '',
          elementType:            r.elementType            || 'N/A',
          linkType:               r.linkType               || 'N/A',
          linkTarget:             r.linkTarget             || 'N/A',
          sourceHref:             r.sourceHref             || 'N/A',
          sourceUrl:              r.sourceUrl              || 'N/A',
          sourceComponent:        r.sourceComponent        || 'N/A',
          sourceElement:          r.sourceElement          || 'N/A',
          viewportSource:         r.viewportSource         || 'N/A',
          angularClassification:  r.angularClassification  || 'standard',
          hasNgxWrapper:          r.hasNgxWrapper ? 'Yes' : 'No',
          hasSpecialAttrs:        r.hasSpecialAttrs ? 'Yes' : 'No',
          isRichText:             r.isRichText ? 'Yes' : 'No',
          expected:               r.expected               || '',
          actual:                 r.actual                 || '',
          status:                 r.status                 || '',
          statusCode:             r.statusCode             || 'N/A',
          redirected:             r.redirected             || 'No',
          anchorIssue:            r.anchorIssue            || 'No',
          error:                  r.error                  || '',
          retryCount:             r.retryCount             ?? 0,
          navigatedLink:          r.navigatedLink          || ''
        });

        const rowFill = statusFills[r.status] || null;
        row.eachCell((cell) => {
          cell.font = cellFont;
          cell.alignment = { vertical: 'top', wrapText: false };
          cell.border = {
            top:    { style: 'hair' },
            left:   { style: 'hair' },
            bottom: { style: 'hair' },
            right:  { style: 'hair' }
          };
          if (rowFill) cell.fill = rowFill;
        });

        // Zebra striping only when no status color applies
        if (!rowFill && idx % 2 === 1) {
          row.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
          });
        }

        row.commit();
      });

      // Freeze header row
      sheet.views = [{ state: 'frozen', ySplit: 1 }];

      // Auto-filter on header row
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to:   { row: 1, column: COLUMNS.length }
      };
    }

    // ── Sheet 1: All Results ─────────────────────────────────────────────
    const allSheet = workbook.addWorksheet('All Results');
    populateSheet(allSheet, results, 'FF1565C0'); // blue header

    // ── Sheet 2: Status Fail ─────────────────────────────────────────────
    // Only include genuine HTTP-failing links here.
    // "Missing Href" and "Span Broken Link" entries are excluded because they
    // already have their own dedicated sheets (sheets 5 & 6). Status Fail is
    // reserved for links that fail HTTP validation (non-2xx/3xx responses).
    const _seenFail = new Set();
    const EXCLUDED_FROM_FAIL_SHEET = new Set(['Missing Href', 'Span Broken Link']);
    const failedResults = results.filter(r => {
      if (r.status !== 'FAIL') return false;
      if (EXCLUDED_FROM_FAIL_SHEET.has(r.elementType)) return false;
      const key = [
        (r.url          || '').trim(),
        (r.navigatedLink|| '').trim(),
        (r.linkText     || '').trim(),
        (r.statusCode   || '').toString().trim()
      ].join('||');
      if (_seenFail.has(key)) return false;
      _seenFail.add(key);
      return true;
    });
    const failSheet = workbook.addWorksheet('Status Fail');
    populateSheet(failSheet, failedResults, 'FFC62828'); // red header

    // ── Sheet 3: Status Info (non-href clickable elements) ───────────────
    const infoResults = results.filter(r => r.status === 'INFO' && r.elementType !== 'Expected Link' && r.elementType !== 'Expected Link (A11Y Fail)');
    const infoSheet = workbook.addWorksheet('Non-Href Clickable');
    populateSheet(infoSheet, infoResults, 'FF0891B2'); // teal header

    // ── Sheet 4: Expected Links - Missing Href ─────────────────────────
    // Elements marked data-expected-link="true" with missing-href status
    // These are CMS/content issues where the URL has not been populated
    const expectedMissingHrefResults = results.filter(r => 
      r.elementType === 'Expected Link' && 
      r.error && 
      r.error.includes('missing-href')
    );
    const expectedMissingHrefSheet = workbook.addWorksheet('Expected Links - Missing Href');
    populateSheet(expectedMissingHrefSheet, expectedMissingHrefResults, 'FFF57f46'); // orange header

    // ── Sheet 5: Missing Href (unannotated bare <a> FAILs) ────────────────
    // <a> tags with no href or empty href that were NOT pre-tagged as data-expected-link.
    // These are genuine broken-link defects requiring a fix or an intentional annotation.
    const missingHrefResults = results.filter(r => r.elementType === 'Missing Href');
    const missingHrefSheet = workbook.addWorksheet('Missing Href');
    populateSheet(missingHrefSheet, missingHrefResults, 'FFB71C1C'); // deep-red header

    // ── Sheet 6: Span Broken Links ─────────────────────────────────────
    // <span> rendered instead of <a href> — link text is visible on the page
    // but the element has no anchor tag and is not navigable (not clickable).
    // Covers: ngx-web-link wrappers with no inner anchor + header/nav spans
    // not inside an <a>. All rows in this sheet are FAIL status.
    const spanBrokenResults = results.filter(r => r.elementType === 'Span Broken Link');
    const spanBrokenSheet = workbook.addWorksheet('Span Broken Links');
    populateSheet(spanBrokenSheet, spanBrokenResults, 'FF7B1FA2'); // purple header

    // ── Write file ────────────────────────────────────────────────────────
    const xlsxFile = path.join(REPORT_DIR, `${environmentName}_Link_Validator_${timestamp}.xlsx`);
    await workbook.xlsx.writeFile(xlsxFile);
    console.log(`📊 Excel report generated: ${xlsxFile}`);
    console.log(`   • "All Results" sheet                  : ${results.length} rows`);
    console.log(`   • "Status Fail" sheet                  : ${failedResults.length} rows`);
    console.log(`   • "Non-Href Clickable" sheet           : ${infoResults.length} rows`);
    console.log(`   • "Expected Links - Missing Href" sheet: ${expectedMissingHrefResults.length} row(s) — CMS/content issue (URL not populated)`);
    console.log(`   • "Missing Href" sheet                 : ${missingHrefResults.length} row(s) — unannotated <a> with no href`);
    console.log(`   • "Span Broken Links" sheet            : ${spanBrokenResults.length} row(s) — link text present but rendered as non-clickable span`);
    console.log('📎 Results exported to CSV, JSON & Excel');
    return xlsxFile;  // returned so caller can run post-processing
  } catch (excelError) {
    console.error(`⚠️ Excel export failed (CSV/JSON still saved): ${excelError.message}`);
    return null;
  }
}
 
// ==================== UTILITY FUNCTIONS ====================
 
/**
 * Read and parse URLs from CSV file
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // Escaped double quote within quoted value: ""
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  fields.push(current.trim());
  return fields;
}

function readUrlsFromCsv() {
  try {
    if (!fs.existsSync(CSV_FILE)) {
      const triedLocations = CSV_CANDIDATE_PATHS.map(p => `\n   - ${p}`).join('');
      throw new Error(`CSV file not found. Tried:${triedLocations}`);
    }

    const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
    const lines = csvContent
      .split(/\r?\n/)
      .map(line => line.replace(/^\uFEFF/, ''))
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));

    if (lines.length === 0) {
      throw new Error('CSV file is empty or contains only comments');
    }

    const rows = lines.map(parseCsvLine);

    // Detect and skip header row if present (Environment,URL)
    const firstRow = rows[0] || [];
    const firstCol = (firstRow[0] || '').toLowerCase();
    const secondCol = (firstRow[1] || '').toLowerCase();
    const hasHeader =
      (firstCol === 'environment' || firstCol === 'env') &&
      (secondCol === 'url' || secondCol === 'link');

    const dataRows = hasHeader ? rows.slice(1) : rows;

    const envNames = new Set();
    const urls = dataRows
      .map(parts => {
        const env = (parts.length > 1 ? parts[0] : '')
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim();
        if (env) envNames.add(env);

        const urlField = parts.length > 1 ? parts[1] : parts[0];
        const url = normalizeSeedUrl((urlField || '')
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim());

        return url;
      })
      .filter(url => url.length > 0);

    // Set environmentName:
    //   - Single unique environment → use that name  (e.g. "UAT-Angular")
    //   - Multiple different environments → "Combined"
    //   - No environment column at all → keep "Unknown"
    if (envNames.size === 1) {
      environmentName = [...envNames][0];
    } else if (envNames.size > 1) {
      environmentName = 'Combined';
    }

    if (urls.length === 0) {
      throw new Error('No URLs found in CSV file');
    }

    console.log(`📋 Found ${urls.length} URL(s) in ${CSV_FILE}`);
    urls.forEach((url, idx) => console.log(`   ${idx + 1}. ${url}`));
    return urls;
  } catch (error) {
    console.error(`❌ Error reading CSV file: ${error.message}`);
    process.exit(1);
  }
}
 
/**
 * Retry wrapper for async functions
 */
async function retryWrapper(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`   Retry ${i + 1}/${retries} failed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}
 
/**
 * Wait for page to be fully loaded
 */
async function waitForPageLoad(page) {
  // Wait for DOMContentLoaded (most important event)
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
  
  // For dynamic pages that may never reach 'complete' state, try with a short timeout
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 });
  } catch (e) {
    // Page didn't reach complete state - that's OK for many modern SPAs
    // domcontentloaded is usually sufficient
  }
  
  // Brief waitfor any critical dynamic content
  await page.waitForTimeout(1000);
}
 
// ==================== LINK EXTRACTION ====================
 
/**
 * Extract all links from the page that are NOT inside the excluded container(s).
 * Excludes: .bolt-header-wc--menuBar-wrapper and bolt-header-wc (nav menu bar - validated separately)
 * Exception: bolt-header-panel-promos is inside bolt-header-wc but IS included (promo/drawer links are page content)
 * Returns an array of objects: { href, text, target, outerHtml }
 */
async function extractLinks(page, baseUrl, modeOverride = null) {
  const effectiveMobileMode = modeOverride !== null ? modeOverride : MOBILE_MODE;
  return await page.evaluate(({ excludedSelector, hostSelector, promoSelector, mobileMode, includeAll, ngxSelector, specialAttrs, richTextSelectors, ctaTextPattern, ctaAttrPattern }) => {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const ctaTextRegex = new RegExp(ctaTextPattern, 'i');
    const ctaAttrRegex = new RegExp(ctaAttrPattern, 'i');

    // Use querySelectorAll to handle multiple instances of the excluded container
    const excludedContainers = Array.from(document.querySelectorAll(excludedSelector));
    // Also grab the web component host element(s) to catch slotted/light-DOM links
    const excludedHosts = Array.from(document.querySelectorAll(hostSelector));

    /**
     * Responsive-aware visibility check.
     * Walks the ancestor chain checking computed styles so that elements hidden
     * by responsive CSS breakpoints (e.g. Foundation's .show-for-small-only which
     * becomes display:none on desktop) are skipped on desktop runs.
     * On mobile runs (mobileMode=true) the same elements are visible → included.
     */
    function isHiddenByCSS(el) {
      let node = el;
      while (node && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        node = node.parentElement;
      }
      return false;
    }

    /**
     * Check if a link is inside ANY excluded container or within the bolt-header-wc host.
     * Uses element.closest() as the primary check (most reliable for nested elements),
     * with a fallback to container.contains() for edge cases.
     *
     * Exception: elements inside bolt-header-panel-promos are ALWAYS included even though
     * that component is a child of the excluded bolt-header-wc host. Promo drawer links
     * are Tridion-managed page content and must be validated by this script.
     */
    const isInsideExcluded = (element) => {
      if (includeAll) return false;
      // Exception: bolt-header-panel-promos content is always validated
      if (element.closest(promoSelector)) return false;
      // Check the class-based wrapper (.bolt-header-wc--menuBar-wrapper)
      if (excludedContainers.length > 0) {
        if (element.closest(excludedSelector)) return true;
        if (excludedContainers.some(container => container.contains(element))) return true;
      }
      // Check the web component host element (bolt-header-wc) for slotted/light-DOM links
      if (excludedHosts.length > 0) {
        if (element.closest(hostSelector)) return true;
        if (excludedHosts.some(host => host.contains(element))) return true;
      }
      return false;
    };

    const excludedLinks = allLinks.filter(link => isInsideExcluded(link));

    // In desktop mode, also skip links that are CSS-hidden (e.g. mobile-only elements).
    // In mobile mode every visible link (including mobile-only ones) is kept.
    const responsiveHiddenLinks = mobileMode
      ? []
      : allLinks.filter(link => !isInsideExcluded(link) && isHiddenByCSS(link));

    /**
     * Determine the element type of an <a> element.
     * Covers:
     *  1. Bolt design-system buttons: the inner <a> carries class "bolt-button-wc"
     *  2. Shadow-DOM buttons: the <a> lives inside a ShadowRoot whose host is bolt-button / <button>
     *  3. Light-DOM ancestors: standard <button> or role="button" parent
     *  4. Generic CSS button classes on the <a> itself (btn / button)
     */
    function getElementType(link) {
      // 1. Class on the <a> itself (e.g. bolt-button-wc, btn, button)
      const cls = (link.className || '').toLowerCase();
      if (cls.includes('bolt-button') || /\bbtn\b|\bbutton\b/.test(cls)) return 'Button link';

      // 2. Shadow-root host (declarative shadow DOM — bolt-button contains an <a> in its shadow)
      try {
        const root = link.getRootNode();
        if (root && root.host) {
          const hostTag = root.host.tagName.toLowerCase();
          if (hostTag === 'button' || hostTag.includes('button')) return 'Button link';
          if (root.host.getAttribute && root.host.getAttribute('role') === 'button') return 'Button link';
        }
      } catch (_) {}

      // 3. Walk light-DOM ancestors for <button> / custom button tags / role="button"
      let el = link.parentElement;
      while (el && el !== document.body) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'button' || tag.includes('button')) return 'Button link';
        if (el.getAttribute && el.getAttribute('role') === 'button') return 'Button link';
        el = el.parentElement;
      }

      return 'HTML link';
    }

    function getSourceComponentPath(element) {
      const parts = [];
      let node = element.parentElement;
      while (node && node !== document.body && parts.length < 6) {
        const tag = node.tagName.toLowerCase();
        if (tag.includes('-')) parts.push(tag);
        node = node.parentElement;
      }
      return parts.join(' > ') || 'N/A';
    }

    function getSourceElement(link, text) {
      const headerPromoTitle = link.querySelector('.bolt-header-promo-title');
      if (headerPromoTitle?.textContent?.trim()) {
        return 'span.bolt-header-promo-title';
      }

      const normalizedText = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const descendants = Array.from(link.querySelectorAll('*'));
      const exactTextElement = descendants.reverse().find(el => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return false;
        const childElementCount = Array.from(el.children || []).filter(child => (child.textContent || '').trim()).length;
        if (childElementCount > 0) return false;
        return (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase() === normalizedText;
      });
      const element = exactTextElement || link;
      const tag = element.tagName.toLowerCase();
      const classNames = (element.getAttribute('class') || '').trim().replace(/\s+/g, '.');
      return classNames ? `${tag}.${classNames}` : tag;
    }

    function getPreferredLinkText(link) {
      const headerPromoTitle = link.querySelector('.bolt-header-promo-title');
      const preferred = headerPromoTitle?.textContent?.trim();
      if (preferred) return preferred;
      return link.textContent?.trim() || link.getAttribute('aria-label') || link.getAttribute('title') || '';
    }

    function getClickValidationData(link, text) {
      const rawHref = link.getAttribute('href') || '';
      const attrSignal = [
        link.getAttribute('class') || '',
        link.getAttribute('id') || '',
        link.getAttribute('onclick') || '',
        link.getAttribute('data-url') || '',
        link.getAttribute('data-href') || '',
        link.getAttribute('data-analytics-click') || '',
        link.outerHTML.substring(0, 300)
      ].join(' ');
      const normalizedRawHref = rawHref.trim().toLowerCase();
      const isPlaceholderHref = normalizedRawHref === '#' || normalizedRawHref === '/test' || normalizedRawHref === 'test';
      const sourceComponent = getSourceComponentPath(link).toLowerCase();
      const isVisualPromoThreeLink = sourceComponent.includes('ngx-web-visual-content-promo-three');
      const shouldClickValidate = isPlaceholderHref && !isVisualPromoThreeLink && (ctaTextRegex.test(text) || ctaAttrRegex.test(attrSignal));
      if (!shouldClickValidate) {
        return { shouldClickValidate: false, clickSelector: '' };
      }

      const validatorId = `href-placeholder-${Math.random().toString(36).slice(2)}`;
      link.setAttribute('data-link-validator-click-id', validatorId);
      return {
        shouldClickValidate: true,
        clickSelector: `[data-link-validator-click-id="${validatorId}"]`
      };
    }

    /**
     * Detect Angular ngx-web-link wrapper pattern for link validation behavior.
     * Returns: { hasWrapper, hasSpecialAttrs, specialAttrNames, isRichTextLink, classification }
     * Includes error handling for invalid selectors (e.g., malformed CSS selectors)
     */
    function detectNgxWebLinkPattern(link) {
      if (!link || !ngxSelector || ngxSelector.length === 0) {
        return { hasWrapper: false, hasSpecialAttrs: false, specialAttrNames: [], isRichTextLink: false, classification: 'standard' };
      }

      // Check for ngx-web-link wrapper (with error handling for invalid selectors)
      let hasWrapper = false;
      try {
        hasWrapper = link.closest(ngxSelector) !== null;
      } catch (e) {
        // Invalid selector - silently skip
        hasWrapper = false;
      }
      
      // Check for special exception attributes if wrapper exists
      let hasSpecialAttrs = false;
      let specialAttrNames = [];
      if (hasWrapper && specialAttrs && specialAttrs.length > 0) {
        try {
          const wrapper = link.closest(ngxSelector);
          specialAttrNames = specialAttrs.filter(attr => wrapper.hasAttribute(attr));
          hasSpecialAttrs = specialAttrNames.length > 0;
        } catch (e) {
          hasSpecialAttrs = false;
          specialAttrNames = [];
        }
      }

      // Check if inside rich text component (with error handling for each selector)
      let isRichTextLink = false;
      if (richTextSelectors && richTextSelectors.length > 0) {
        for (const richTextSelector of richTextSelectors) {
          try {
            if (link.closest(richTextSelector)) {
              isRichTextLink = true;
              break;
            }
          } catch (e) {
            // Invalid selector - continue to next one
            continue;
          }
        }
      }

      // Determine classification based on pattern
      let classification = 'standard';
      if (hasWrapper && !hasSpecialAttrs) {
        classification = 'angular-valid';  // ✅ ngx-web-link without exceptions
      } else if (hasWrapper && hasSpecialAttrs) {
        classification = 'angular-exception';  // ⚠️ ngx-web-link with special attributes
      } else if (!hasWrapper && isRichTextLink) {
        classification = 'rich-text-content';  // ✅ Content-managed link
      }

      return {
        hasWrapper,
        hasSpecialAttrs,
        specialAttrNames,
        isRichTextLink,
        classification
      };
    }

    /**
     * Detect whether an <a> is a "Go button" driven by a paired <select> dropdown.
     * Pattern used by Nationwide's VCP Drawer on mobile:
     *   <select id="dd1"><option value="/some/path">...</option></select>
     *   <a id="buttonForDD1" href="Make a selection">Go</a>
     *
     * Detection heuristics (any one is sufficient):
     *  1. The raw href does not look like a URL/path (no leading /, http, #, ?, .)
     *  2. The anchor id matches buttonForDDn convention and a sibling select element exists
     * Returns the paired select element if found, otherwise null.
     */
    function findPairedSelect(link) {
      const rawHref = link.getAttribute('href') || '';

      // Heuristic 1: href is not a navigable URL — likely still holding placeholder text
      const looksLikePlaceholder = rawHref.length > 0
        && !rawHref.startsWith('/')
        && !rawHref.startsWith('http')
        && !rawHref.startsWith('#')
        && !rawHref.startsWith('?')
        && !rawHref.startsWith('.')
        && !rawHref.startsWith('javascript');

      if (!looksLikePlaceholder) return null;

      // Heuristic 2: resolve the paired <select> by id naming convention (buttonForDD1 → dd1)
      const linkId = link.id || '';
      const ddMatch = linkId.match(/button.*?for.*?(dd\d+)/i) || linkId.match(/button.*?(dd\d+)/i);
      if (ddMatch) {
        const sel = document.getElementById(ddMatch[1]);
        if (sel && sel.tagName === 'SELECT') return sel;
      }

      // Heuristic 3: fall back to closest sibling/ancestor <select>
      const parent = link.parentElement;
      if (parent) {
        const siblingSelect = parent.querySelector('select');
        if (siblingSelect) return siblingSelect;
        // One level up
        if (parent.parentElement) {
          const cousinSelect = parent.parentElement.querySelector('select');
          if (cousinSelect) return cousinSelect;
        }
      }

      return null;
    }

    /**
     * Given a paired <select>, return link entries for every <option> that has a
     * non-empty, non-placeholder value (i.e. looks like a URL path).
     */
    function expandSelectOptions(select, baseOrigin, buttonText) {
      const entries = [];
      const options = Array.from(select.options);
      for (const opt of options) {
        const val = opt.value || '';
        if (!val || opt.disabled) continue;
        // Skip placeholder-like values (no leading slash or http)
        if (!val.startsWith('/') && !val.startsWith('http')) continue;

        const resolvedHref = val.startsWith('http') ? val : (baseOrigin + val);
        entries.push({
          href: resolvedHref,
          rawHref: val,
          text: (opt.textContent || '').trim().substring(0, 100) || buttonText,
          target: '',
          outerHtml: opt.outerHTML.substring(0, 200),
          elementType: 'Button link',
          selectDriven: true  // marker so logs can mention the expansion
        });
      }
      return entries;
    }

    const origin = window.location.origin;
    const validLinks = [];

    const candidateLinks = allLinks
      .filter(link => includeAll || !isInsideExcluded(link))
      .filter(link => includeAll || mobileMode || !isHiddenByCSS(link)); // skip CSS-hidden mobile-only links on desktop unless report-all

    let selectExpandedCount = 0;

    for (const link of candidateLinks) {
      const pairedSelect = findPairedSelect(link);

      if (pairedSelect) {
        // This is a select-driven Go button — expand its <option> values instead
        const expanded = expandSelectOptions(pairedSelect, origin,
          link.textContent?.trim() || 'Go button option');
        validLinks.push(...expanded);
        selectExpandedCount += expanded.length;
      } else {
        let text = getPreferredLinkText(link);
        text = text.substring(0, 100);
        if (!text) text = 'Unnamed link';
        const clickValidationData = getClickValidationData(link, text);

        // Detect Angular ngx-web-link pattern
        const ngxPattern = detectNgxWebLinkPattern(link);

        validLinks.push({
          href: link.href,
          rawHref: link.getAttribute('href'),
          text: text,
          target: link.getAttribute('target') || '',
          outerHtml: link.outerHTML.substring(0, 200),
          elementType: getElementType(link),
          // Angular ngx-web-link detection fields
          angularClassification: ngxPattern.classification,
          hasNgxWrapper: ngxPattern.hasWrapper,
          hasSpecialAttrs: ngxPattern.hasSpecialAttrs,
          specialAttrNames: ngxPattern.specialAttrNames,
          isRichText: ngxPattern.isRichTextLink,
          sourceComponent: getSourceComponentPath(link),
          sourceElement: getSourceElement(link, text),
          shouldClickValidate: clickValidationData.shouldClickValidate,
          clickSelector: clickValidationData.clickSelector
        });
      }
    }

    // Defensive completeness pass:
    // ensure every visible candidate anchor is represented at least once in the
    // extracted results, even if custom extraction logic above missed it.
    const seenKeys = new Set(
      validLinks.map(item => `${item.href || ''}|${item.text || ''}|${item.target || ''}`)
    );

    for (const link of candidateLinks) {
      let text = getPreferredLinkText(link);
      text = text.substring(0, 100);
      if (!text) text = 'Unnamed link';
      const clickValidationData = getClickValidationData(link, text);

      const fallbackKey = `${link.href || ''}|${text}|${link.getAttribute('target') || ''}`;
      if (seenKeys.has(fallbackKey)) continue;

      const ngxPattern = detectNgxWebLinkPattern(link);
      validLinks.push({
        href: link.href,
        rawHref: link.getAttribute('href'),
        text,
        target: link.getAttribute('target') || '',
        outerHtml: link.outerHTML.substring(0, 200),
        elementType: getElementType(link),
        angularClassification: ngxPattern.classification,
        hasNgxWrapper: ngxPattern.hasWrapper,
        hasSpecialAttrs: ngxPattern.hasSpecialAttrs,
        specialAttrNames: ngxPattern.specialAttrNames,
        isRichText: ngxPattern.isRichTextLink,
        sourceComponent: getSourceComponentPath(link),
        sourceElement: getSourceElement(link, text),
        shouldClickValidate: clickValidationData.shouldClickValidate,
        clickSelector: clickValidationData.clickSelector
      });
      seenKeys.add(fallbackKey);
    }

    // Attach excluded count so it can be logged by the caller
    validLinks._excludedCount = excludedLinks.length;
    validLinks._containerFound = excludedContainers.length + excludedHosts.length;
    validLinks._responsiveHiddenCount = responsiveHiddenLinks.length;
    validLinks._selectExpandedCount = selectExpandedCount;
    return validLinks;
  }, { 
    excludedSelector: EXCLUDED_CONTAINER_SELECTOR, 
    hostSelector: EXCLUDED_HOST_SELECTOR,
    promoSelector: INCLUDED_PANEL_SELECTOR,
    mobileMode: effectiveMobileMode,
    includeAll: REPORT_ALL_MODE,
    ngxSelector: NGX_WEB_LINK_WRAPPER_SELECTOR,
    specialAttrs: NGX_SPECIAL_ATTRIBUTES,
    richTextSelectors: RICH_TEXT_COMPONENT_SELECTORS,
    ctaTextPattern: JS_NAVIGATION_CTA_TEXT_PATTERN.source,
    ctaAttrPattern: JS_NAVIGATION_CTA_ATTR_PATTERN.source
  });
}

/**
 * Extract links from bolt-header-wc panel components including promotional tiles.
 *
 * The bolt-header-wc nav panels (.bolt-header-panel-promos, .bolt-header-panel-footer)
 * are LAZILY RENDERED by Angular — they only appear in the DOM after clicking/hovering
 * on a nav tab (e.g., "Business Insurance", "Farm & Ag"). Regular panel links
 * (.bolt-header-panel-links-all) ARE pre-rendered.
 *
 * Strategy:
 *   1. Find all nav tab triggers inside bolt-header-wc
 *   2. Click each one to force Angular to render the panel
 *   3. Extract links from .bolt-header-panel-promos and .bolt-header-panel-footer
 *   4. Repeat for each tab, deduplicating hrefs across all panels
 *
 * Targets: .bolt-header-panel-promos and .bolt-header-panel-footer
 */
async function extractShadowPanelLinks(page, baseUrl) {
  const results = [];
  const seenHrefs = new Set();

  // --- Helper: extract promo + footer links from currently-open panel ---
  async function extractOpenPanelLinks() {
    const panelSelectors = [
      '.bolt-header-panel-promos a[href]',
      '.bolt-header-panel-footer a[href]'
    ];
    for (const sel of panelSelectors) {
      let locators = [];
      try { locators = await page.locator(sel).all(); } catch (_) { continue; }
      for (const loc of locators) {
        try {
          const data = await loc.evaluate((el, base) => {
            const href = el.href || el.getAttribute('href') || '';
            const rawHref = el.getAttribute('href') || '';
            const headerPromoTitle = el.querySelector('.bolt-header-promo-title')?.textContent?.trim();
            const text = (headerPromoTitle || el.textContent?.trim() || el.getAttribute('aria-label') || el.title || 'Unnamed link').substring(0, 100);
            const target = el.getAttribute('target') || '';
            const hasNgxWrapper = !!el.closest('.ngx-web-link, ngx-web-link');
            return { href, rawHref, text, target, hasNgxWrapper };
          }, baseUrl);
          if (!data.href || seenHrefs.has(data.href)) continue;
          seenHrefs.add(data.href);
          results.push({
            href: data.href,
            rawHref: data.rawHref,
            text: data.text,
            target: data.target,
            outerHtml: '',
            elementType: 'HTML link',
            angularClassification: data.hasNgxWrapper ? 'angular-valid' : 'standard',
            hasNgxWrapper: data.hasNgxWrapper,
            hasSpecialAttrs: false,
            isRichText: false,
            viewportSource: 'Desktop',
            _fromShadowPanel: true
          });
        } catch (_) { /* stale handle */ }
      }
    }
  }

  // --- Step 1: Check if promo panels are already in DOM (not needing interaction) ---
  const existingPromoCount = await page.locator('.bolt-header-panel-promos a[href]').count().catch(() => 0);
  if (existingPromoCount > 0) {
    await extractOpenPanelLinks();
    results._shadowPanelCount = results.length;
    return results;
  }

  // --- Step 2: Find nav tab triggers and click each to force panel rendering ---
  // Try multiple possible selectors for bolt-header nav tabs
  const navTriggerSelectors = [
    'bolt-header-wc .bolt-header-tab',
    'bolt-header-wc .bolt-header-nav-bar-item',
    'bolt-header-wc [class*="bolt-header-tab"]',
    'bolt-header-wc [class*="nav-bar-item"]',
    'bolt-header-wc nav button',
    'bolt-header-wc [role="tab"]',
    'bolt-header-wc [role="menuitem"]',
    '[class*="bolt-header-nav"] [class*="tab"]',
    '[class*="bolt-header-nav"] button'
  ];

  let navTriggers = [];
  for (const sel of navTriggerSelectors) {
    try {
      const locs = await page.locator(sel).all();
      if (locs.length > 0) {
        navTriggers = locs;
        break;
      }
    } catch (_) { continue; }
  }

  if (navTriggers.length === 0) {
    // No known nav triggers found — nothing to click to reveal promo panels
    results._shadowPanelCount = 0;
    return results;
  }

  for (const trigger of navTriggers) {
    try {
      // Click to open panel
      await trigger.click({ timeout: 3000, force: true });
      // Give Angular time to render the panel
      await page.waitForTimeout(500);
      // Check if promo panel appeared
      const promoCount = await page.locator('.bolt-header-panel-promos a[href]').count().catch(() => 0);
      if (promoCount > 0) {
        await extractOpenPanelLinks();
      }
      // Try footer too
      const footerCount = await page.locator('.bolt-header-panel-footer a[href]').count().catch(() => 0);
      if (footerCount > 0) {
        await extractOpenPanelLinks(); // dedup handles repeats
      }
      // Close panel before trying next tab
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    } catch (_) { /* trigger not clickable, skip */ }
  }

  results._shadowPanelCount = results.length;
  return results;
}

/**
 * Extract links from bolt-tile style web components whose navigable anchors live
 * inside open shadow roots rather than the light DOM.
 *
 * Targets: bolt-tile, bolt-card-tile, bolt-tile-cta, bolt-linked-list-item
 */
async function extractBoltTileShadowLinks(page, baseUrl) {
  const tileSelectors = [
    'bolt-tile',
    'bolt-card-tile',
    'bolt-tile-cta',
    'bolt-linked-list-item'
  ];

  const results = [];
  const seenKeys = new Set();

  for (const selector of tileSelectors) {
    let hosts = [];
    try {
      hosts = await page.locator(selector).all();
    } catch (_) {
      continue;
    }

    for (const host of hosts) {
      let links = [];
      try {
        links = await host.evaluate((el) => {
          const root = el.shadowRoot;
          if (!root) return [];

          function getSourceComponentPath(element) {
            const parts = [element.tagName.toLowerCase()];
            let node = element.parentElement;
            while (node && node !== document.body && parts.length < 6) {
              const tag = node.tagName.toLowerCase();
              if (tag.includes('-')) parts.push(tag);
              node = node.parentElement;
            }
            return parts.join(' > ') || 'N/A';
          }

          return Array.from(root.querySelectorAll('a[href]')).map((anchor) => {
            const labelElement = anchor.querySelector('.bolt-tile-wc--label span') || root.querySelector('.bolt-tile-wc--label span');
            const text = (
              labelElement?.textContent?.trim() ||
              anchor.textContent?.trim() ||
              anchor.getAttribute('aria-label') ||
              anchor.getAttribute('title') ||
              el.getAttribute('data-title') ||
              el.getAttribute('title') ||
              'Unnamed link'
            ).replace(/\s+/g, ' ').substring(0, 100);

            return {
              href: anchor.href || anchor.getAttribute('href') || '',
              rawHref: anchor.getAttribute('href') || '',
              text,
              target: anchor.getAttribute('target') || '',
              hostTag: el.tagName.toLowerCase(),
              sourceComponent: getSourceComponentPath(el),
              sourceElement: labelElement ? 'bolt-tile.shadowRoot .bolt-tile-wc--label span' : 'bolt-tile.shadowRoot a'
            };
          });
        });
      } catch (_) {
        continue;
      }

      for (const link of links) {
        if (!link.href) continue;
        const key = `${link.href}|${link.text}|${link.target}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        results.push({
          href: link.href,
          rawHref: link.rawHref,
          text: link.text,
          target: link.target,
          outerHtml: '',
          elementType: 'HTML link',
          angularClassification: 'standard',
          hasNgxWrapper: false,
          hasSpecialAttrs: false,
          isRichText: false,
          viewportSource: 'Desktop',
          _fromBoltTileShadow: true,
          _boltTileHostTag: link.hostTag,
          sourceComponent: link.sourceComponent || 'bolt-tile',
          sourceElement: link.sourceElement || 'bolt-tile.shadowRoot a'
        });
      }
    }
  }

  results._boltTileShadowCount = results.length;
  return results;
}

/**
 * Extract links from bolt-button web components whose real anchors live inside
 * open shadow roots rather than the light DOM.
 */
async function extractBoltButtonShadowLinks(page, baseUrl) {
  const results = [];
  const seenKeys = new Set();

  let hosts = [];
  try {
    hosts = await page.locator('bolt-button').all();
  } catch (_) {
    results._boltButtonShadowCount = 0;
    return results;
  }

  for (const host of hosts) {
    let links = [];
    try {
      links = await host.evaluate((el, { ctaTextPattern, ctaAttrPattern }) => {
        const root = el.shadowRoot;
        if (!root) return [];
        const ctaTextRegex = new RegExp(ctaTextPattern, 'i');
        const ctaAttrRegex = new RegExp(ctaAttrPattern, 'i');

        function getSourceComponentPath(element) {
          const parts = [];
          let node = element.parentElement;
          while (node && node !== document.body && parts.length < 6) {
            const tag = node.tagName.toLowerCase();
            if (tag.includes('-')) parts.push(tag);
            node = node.parentElement;
          }
          return parts.join(' > ') || 'N/A';
        }

        return Array.from(root.querySelectorAll('a[href]')).map((anchor, index) => {
          const text = (
            el.textContent?.trim() ||
            anchor.textContent?.trim() ||
            el.getAttribute('aria-label') ||
            anchor.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            anchor.getAttribute('title') ||
            'Unnamed button'
          ).replace(/\s+/g, ' ').substring(0, 100);
          const rawHref = anchor.getAttribute('href') || '';
          const normalizedRawHref = rawHref.trim().toLowerCase();
          const isPlaceholderHref = normalizedRawHref === '#' || normalizedRawHref === '/test' || normalizedRawHref === 'test';
          const attrSignal = [
            el.getAttribute('class') || '',
            el.getAttribute('id') || '',
            el.getAttribute('onclick') || '',
            el.getAttribute('data-url') || '',
            el.getAttribute('data-href') || '',
            el.getAttribute('data-analytics-click') || '',
            el.outerHTML.substring(0, 300),
            anchor.outerHTML.substring(0, 300)
          ].join(' ');
          const shouldClickValidate = isPlaceholderHref && (ctaTextRegex.test(text) || ctaAttrRegex.test(attrSignal));
          const validatorId = `bolt-button-shadow-${index}-${Math.random().toString(36).slice(2)}`;
          if (shouldClickValidate) {
            el.setAttribute('data-link-validator-click-id', validatorId);
          }

          return {
            href: anchor.href || anchor.getAttribute('href') || '',
            rawHref,
            text,
            target: anchor.getAttribute('target') || el.getAttribute('target') || '',
            outerHtml: anchor.outerHTML.substring(0, 200),
            hostHtml: el.outerHTML.substring(0, 200),
            sourceComponent: getSourceComponentPath(el),
            sourceElement: 'bolt-button',
            shouldClickValidate,
            clickSelector: shouldClickValidate ? `[data-link-validator-click-id="${validatorId}"]` : ''
          };
        });
      }, {
        ctaTextPattern: JS_NAVIGATION_CTA_TEXT_PATTERN.source,
        ctaAttrPattern: JS_NAVIGATION_CTA_ATTR_PATTERN.source
      });
    } catch (_) {
      continue;
    }

    for (const link of links) {
      if (!link.href) continue;
      const key = `${link.href}|${link.text}|${link.target}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      results.push({
        href: link.href,
        rawHref: link.rawHref,
        text: link.text,
        target: link.target,
        outerHtml: link.outerHtml || link.hostHtml || '',
        elementType: 'Button link',
        angularClassification: 'standard',
        hasNgxWrapper: false,
        hasSpecialAttrs: false,
        isRichText: false,
        viewportSource: 'Desktop',
        _fromBoltButtonShadow: true,
        sourceComponent: link.sourceComponent || 'N/A',
        sourceElement: link.sourceElement || 'bolt-button',
        shouldClickValidate: link.shouldClickValidate || false,
        clickSelector: link.clickSelector || ''
      });
    }
  }

  results._boltButtonShadowCount = results.length;
  return results;
}

/**
 * Extract non-href clickable elements (buttons, elements with role="button", JS-navigated elements)
 * Returns an array of objects: { href, rawHref, text, target, outerHtml, elementType, clickableType }
 * These are links that navigate via onClick handlers or routing, not traditional <a href> links
 */
async function extractNonHrefLinks(page, baseUrl) {
  return await page.evaluate(({ excludedSelector, hostSelector, promoSelector, includeAll, ctaTextPattern, ctaAttrPattern }) => {
    const results = [];
    const seenLinkTexts = new Set(); // Avoid duplicates
    const ctaTextRegex = new RegExp(ctaTextPattern, 'i');
    const ctaAttrRegex = new RegExp(ctaAttrPattern, 'i');

    // Exclude same containers as regular links
    const excludedContainers = Array.from(document.querySelectorAll(excludedSelector));
    const excludedHosts = Array.from(document.querySelectorAll(hostSelector));

    const isInsideExcluded = (element) => {
      if (includeAll) return false;
      // Exception: bolt-header-panel-promos content is always validated
      if (element.closest(promoSelector)) return false;
      if (excludedContainers.length > 0) {
        if (element.closest(excludedSelector)) return true;
        if (excludedContainers.some(container => container.contains(element))) return true;
      }
      if (excludedHosts.length > 0) {
        if (element.closest(hostSelector)) return true;
        if (excludedHosts.some(host => host.contains(element))) return true;
      }
      return false;
    };

    function getSourceComponentPath(element) {
      const parts = [];
      let node = element.parentElement;
      while (node && node !== document.body && parts.length < 6) {
        const tag = node.tagName.toLowerCase();
        if (tag.includes('-')) parts.push(tag);
        node = node.parentElement;
      }
      return parts.join(' > ') || 'N/A';
    }

    function getElementSignature(element) {
      const tag = element.tagName.toLowerCase();
      const classNames = (element.getAttribute('class') || '').trim().replace(/\s+/g, '.');
      return classNames ? `${tag}.${classNames}` : tag;
    }

    // 1. Extract <button> elements (excluding those already inside <a> tags)
    const buttons = Array.from(document.querySelectorAll('button:not(a button)'));
    for (const btn of buttons) {
      if (isInsideExcluded(btn)) continue;

      const text = btn.textContent?.trim() || btn.getAttribute('aria-label') || btn.title || 'Unnamed button';
      if (seenLinkTexts.has(text)) continue;
      seenLinkTexts.add(text);

      // Try to extract navigation info from onclick handler or data attributes
      const onclickAttr = btn.getAttribute('onclick') || '';
      const dataUrl = btn.getAttribute('data-url') || btn.getAttribute('data-href') || '';
      const routerLink = btn.getAttribute('[routerLink]') || btn.getAttribute('routerLink') || btn.getAttribute('ng-click') || '';

      let detectedUrl = '';
      if (dataUrl) detectedUrl = dataUrl;
      else if (routerLink) detectedUrl = routerLink;
      else if (onclickAttr.includes('http') || onclickAttr.includes('/')) {
        const match = onclickAttr.match(/['"`](https?:\/\/[^'"`]+|\/[^'"`]+)['"`]/);
        detectedUrl = match ? match[1] : '';
      }

      results.push({
        href: detectedUrl || '#internal-navigation', // Placeholder for non-URL buttons
        rawHref: detectedUrl || '',
        text: text.substring(0, 100),
        target: btn.getAttribute('target') || '',
        outerHtml: btn.outerHTML.substring(0, 200),
        elementType: 'Button link',
        clickableType: 'button',
        sourceComponent: getSourceComponentPath(btn),
        sourceElement: getElementSignature(btn),
        navigationSource: detectedUrl ? 'attribute' : 'handler'
      });
    }

    // 2. Extract elements with role="button" (excluding those already found)
    const roleButtons = Array.from(document.querySelectorAll('[role="button"]:not(a[role="button"]):not(button)'));
    for (const elem of roleButtons) {
      if (isInsideExcluded(elem)) continue;

      const text = elem.textContent?.trim() || elem.getAttribute('aria-label') || elem.title || 'Unnamed button';
      if (seenLinkTexts.has(text)) continue;
      seenLinkTexts.add(text);

      const onclickAttr = elem.getAttribute('onclick') || '';
      const dataUrl = elem.getAttribute('data-url') || '';
      const routerLink = elem.getAttribute('[routerLink]') || elem.getAttribute('routerLink') || '';

      let detectedUrl = '';
      if (dataUrl) detectedUrl = dataUrl;
      else if (routerLink) detectedUrl = routerLink;
      else if (onclickAttr.includes('http') || onclickAttr.includes('/')) {
        const match = onclickAttr.match(/['"`](https?:\/\/[^'"`]+|\/[^'"`]+)['"`]/);
        detectedUrl = match ? match[1] : '';
      }

      results.push({
        href: detectedUrl || '#internal-navigation',
        rawHref: detectedUrl || '',
        text: text.substring(0, 100),
        target: elem.getAttribute('target') || '',
        outerHtml: elem.outerHTML.substring(0, 200),
        elementType: 'Button link',
        clickableType: 'role-button',
        sourceComponent: getSourceComponentPath(elem),
        sourceElement: getElementSignature(elem),
        navigationSource: detectedUrl ? 'attribute' : 'handler'
      });
    }

    // 3. Extract Bolt button hosts without rendered anchors (common in ngx promo groups)
    const boltButtons = Array.from(document.querySelectorAll('bolt-button'));
    for (const boltButton of boltButtons) {
      if (isInsideExcluded(boltButton)) continue;
      if (boltButton.shadowRoot?.querySelector('a[href]')) continue;
      if (boltButton.querySelector('a[href], button, [role="button"]')) continue;

      const text = boltButton.textContent?.trim() || boltButton.getAttribute('aria-label') || boltButton.title || 'Unnamed button';
      if (seenLinkTexts.has(text)) continue;
      seenLinkTexts.add(text);

      const attrSignal = [
        boltButton.getAttribute('class') || '',
        boltButton.getAttribute('id') || '',
        boltButton.getAttribute('onclick') || '',
        boltButton.getAttribute('data-url') || '',
        boltButton.getAttribute('data-href') || '',
        boltButton.getAttribute('data-analytics-click') || '',
        boltButton.outerHTML.substring(0, 300)
      ].join(' ');
      const dataUrl = boltButton.getAttribute('data-url') || boltButton.getAttribute('data-href') || '';
      const routerLink = boltButton.getAttribute('[routerLink]') || boltButton.getAttribute('routerLink') || '';
      const shouldClickValidate = ctaTextRegex.test(text) || ctaAttrRegex.test(attrSignal);
      const validatorId = `bolt-button-${results.length}-${Math.random().toString(36).slice(2)}`;
      boltButton.setAttribute('data-link-validator-click-id', validatorId);

      results.push({
        href: dataUrl || routerLink || '#internal-navigation',
        rawHref: dataUrl || routerLink || '',
        text: text.substring(0, 100),
        target: boltButton.getAttribute('target') || '',
        outerHtml: boltButton.outerHTML.substring(0, 200),
        elementType: 'Button link',
        clickableType: 'bolt-button',
        sourceComponent: getSourceComponentPath(boltButton),
        sourceElement: getElementSignature(boltButton),
        navigationSource: dataUrl || routerLink ? 'attribute' : (shouldClickValidate ? 'click' : ''),
        shouldClickValidate,
        clickSelector: `[data-link-validator-click-id="${validatorId}"]`
      });
    }

    // 4. Extract elements with onclick handlers that look like navigation
    const clickableElements = Array.from(document.querySelectorAll('[onclick]'));
    for (const elem of clickableElements) {
      if (isInsideExcluded(elem)) continue;
      // Skip if it's a button or already has role="button"
      if (elem.tagName === 'BUTTON' || elem.getAttribute('role') === 'button') continue;

      const onclick = elem.getAttribute('onclick') || '';
      // Only include if it looks like navigation (contains navigate, route, location, window.open, href, etc.)
      if (!/(navigate|route|location|window\.open|href|goTo|goto|redirect)/i.test(onclick)) continue;

      const text = elem.textContent?.trim() || elem.getAttribute('aria-label') || elem.title || 'Unnamed clickable';
      if (seenLinkTexts.has(text)) continue;
      seenLinkTexts.add(text);

      const dataUrl = elem.getAttribute('data-url') || '';
      let detectedUrl = '';
      if (dataUrl) detectedUrl = dataUrl;
      else {
        const match = onclick.match(/['"`](https?:\/\/[^'"`]+|\/[^'"`]+)['"`]/);
        detectedUrl = match ? match[1] : '';
      }

      results.push({
        href: detectedUrl || '#internal-navigation',
        rawHref: detectedUrl || '',
        text: text.substring(0, 100),
        target: elem.getAttribute('target') || '',
        outerHtml: elem.outerHTML.substring(0, 200),
        elementType: 'JS link',
        clickableType: 'onclick-handler',
        sourceComponent: getSourceComponentPath(elem),
        sourceElement: getElementSignature(elem),
        navigationSource: detectedUrl ? 'attribute' : 'handler'
      });
    }

    results._nonHrefCount = results.length;
    return results;
  }, {
    excludedSelector: EXCLUDED_CONTAINER_SELECTOR,
    hostSelector: EXCLUDED_HOST_SELECTOR,
    promoSelector: INCLUDED_PANEL_SELECTOR,
    includeAll: REPORT_ALL_MODE,
    ctaTextPattern: JS_NAVIGATION_CTA_TEXT_PATTERN.source,
    ctaAttrPattern: JS_NAVIGATION_CTA_ATTR_PATTERN.source
  });
}

/**
 * Extract elements marked with data-expected-link="true"
 *
 * These are intentionally broken links (missing href, invalid URL, etc.)
 * that have been explicitly annotated so automation can:
 *   1. Report them as INFO (not FAIL) — content/config issue, not app failure
 *   2. Guard against accessibility regressions (tabindex, role="link", or <a> tag)
 *   3. Validate that they follow the ngx-web-link wrapper pattern
 *
 * Expected pattern: Should be wrapped with ngx-web-link component
 * 
 * data-link-status values (from content team):
 *   missing-href   → CMS/content issue — URL not populated
 *   invalid-url    → Config or data issue — URL malformed
 *   (any other)    → Custom reason from team
 */
async function extractExpectedLinks(page) {
  return await page.evaluate(({ ngxSelector }) => {
    const results = [];
    const elements = Array.from(document.querySelectorAll('[data-expected-link="true"]'));

    for (const elem of elements) {
      const text = elem.textContent?.trim() || elem.getAttribute('aria-label') || elem.title || 'Unnamed expected link';
      const linkStatus = elem.getAttribute('data-link-status') || 'no-status-provided';
      const tagName = elem.tagName.toLowerCase();

      // ── Check ngx-web-link wrapper pattern ────────────────────────────
      let hasNgxWrapper = false;
      try {
        hasNgxWrapper = elem.closest(ngxSelector) !== null;
      } catch (e) {
        hasNgxWrapper = false;
      }

      // ── Step 5: Accessibility regression guards ──────────────────────
      const hasTabindex = elem.hasAttribute('tabindex');
      const hasRoleLink = (elem.getAttribute('role') || '').toLowerCase() === 'link';
      const isAnchorTag = tagName === 'a';

      const accessibilityViolations = [];
      if (isAnchorTag)  accessibilityViolations.push('Element is an <a> tag (should be <span> or non-interactive)');
      if (hasTabindex)  accessibilityViolations.push(`Has tabindex="${elem.getAttribute('tabindex')}" (must not be keyboard-focusable)`);
      if (hasRoleLink)  accessibilityViolations.push('Has role="link" (must not be announced as a link)');

      results.push({
        text: text.substring(0, 120),
        tagName,
        linkStatus,               // data-link-status value (reason)
        outerHtml: elem.outerHTML.substring(0, 300),
        accessibilityViolations,  // [] = clean, [...] = regression detected
        isAccessibilityClean: accessibilityViolations.length === 0,
        hasNgxWrapper            // Whether wrapped with ngx-web-link
      });
    }

    results._expectedCount = results.length;
    return results;
  }, { ngxSelector: NGX_WEB_LINK_WRAPPER_SELECTOR });
}

/**
 * Detect <a> elements that have NO href (or an empty href) and are NOT already
 * annotated with data-expected-link="true".
 *
 * These represent genuinely unhandled missing links — they were not caught by
 * the data-expected-link workflow and must be flagged as FAIL.
 *
 * Exclusions applied (matching the rest of the script):
 *   - Links inside the bolt-header-wc nav bar (handled by a separate script)
 *   - Links already carrying data-expected-link="true" (handled above)
 *
 * Returns an array of plain objects describing each offending element.
 */
async function detectUnannotatedMissingHrefs(page) {
  return await page.evaluate(({ excludedSelector, hostSelector, promoSelector, includeAll, ctaTextPattern, ctaAttrPattern }) => {
    // All <a> tags with missing or empty href — light DOM only
    // (bolt-header-wc uses closed shadow DOM; missing-href detection inside
    //  shadow panels is handled by extractShadowPanelLinks which validates hrefs via HTTP)
    const candidates = Array.from(
      document.querySelectorAll('a:not([href]), a[href=""]')
    );

    const excludedContainers = Array.from(document.querySelectorAll(excludedSelector));
    const excludedHosts      = Array.from(document.querySelectorAll(hostSelector));

    function isInsideExcluded(el) {
      if (includeAll) return false;
      // Exception: bolt-header-panel-promos content is always validated
      if (el.closest(promoSelector)) return false;
      if (excludedContainers.length > 0) {
        if (el.closest(excludedSelector)) return true;
        if (excludedContainers.some(c => c.contains(el))) return true;
      }
      if (excludedHosts.length > 0) {
        if (el.closest(hostSelector)) return true;
        if (excludedHosts.some(h => h.contains(el))) return true;
      }
      return false;
    }

    const ctaTextRegex = new RegExp(ctaTextPattern, 'i');
    const ctaAttrRegex = new RegExp(ctaAttrPattern, 'i');

    function getSourceComponentPath(element) {
      const parts = [];
      let node = element.parentElement;
      while (node && node !== document.body && parts.length < 6) {
        const tag = node.tagName.toLowerCase();
        if (tag.includes('-')) parts.push(tag);
        node = node.parentElement;
      }
      return parts.join(' > ') || 'N/A';
    }

    function getElementSignature(element) {
      const tag = element.tagName.toLowerCase();
      const classNames = (element.getAttribute('class') || '').trim().replace(/\s+/g, '.');
      return classNames ? `${tag}.${classNames}` : tag;
    }

    return candidates
      .filter(el => el.getAttribute('data-expected-link') !== 'true') // already handled
      .filter(el => !isInsideExcluded(el))                            // excluded nav bar (promo panel always included)
      .filter(el => !el.hasAttribute('aria-haspopup'))                // popup/dialog triggers — intentional, not broken links
      .map((el, index) => {
        const validatorId = `missing-href-${index}`;
        el.setAttribute('data-link-validator-missing-href-id', validatorId);

        const text = (el.textContent?.trim() || el.getAttribute('aria-label') || el.title || 'Unnamed').substring(0, 120);
        const attrSignal = [
          el.getAttribute('class') || '',
          el.getAttribute('id') || '',
          el.getAttribute('onclick') || '',
          el.getAttribute('data-url') || '',
          el.getAttribute('data-href') || '',
          el.getAttribute('data-analytics-click') || '',
          el.outerHTML.substring(0, 300)
        ].join(' ');

        return {
          tagName:   el.tagName.toLowerCase(),
          text,
          outerHtml: el.outerHTML.substring(0, 300),
          hasHref:   el.hasAttribute('href'),   // false = completely absent, true = present but empty
          linkStatus: el.getAttribute('data-link-status') || 'no-status-provided',
          sourceComponent: getSourceComponentPath(el),
          sourceElement: getElementSignature(el),
          clickSelector: `[data-link-validator-missing-href-id="${validatorId}"]`,
          shouldClickValidate: ctaTextRegex.test(text) || ctaAttrRegex.test(attrSignal)
        };
      });
  }, {
    excludedSelector: EXCLUDED_CONTAINER_SELECTOR,
    hostSelector: EXCLUDED_HOST_SELECTOR,
    promoSelector: INCLUDED_PANEL_SELECTOR,
    includeAll: REPORT_ALL_MODE,
    ctaTextPattern: JS_NAVIGATION_CTA_TEXT_PATTERN.source,
    ctaAttrPattern: JS_NAVIGATION_CTA_ATTR_PATTERN.source
  });
}

/**
 * Detect bolt-tile web component elements whose anchor resolves to href="/"
 *
 * Bolt Design System tiles render <a href="/"> as a placeholder when no URL
 * has been configured in the CMS.  href="/" is a technically valid relative URL
 * (it resolves to the site root) so it slips through standard missing-href
 * detection — but on a tile it signals a broken/unconfigured link, not an
 * intentional homepage reference.
 *
 * Detection strategy:
 *   Query all <bolt-tile> custom elements (and the common variant
 *   <bolt-card-tile>) for descendant <a> tags whose raw getAttribute('href')
 *   is exactly "/" — these are the unconfigured-link placeholders.
 *
 * Returns an array of plain objects describing each offending tile anchor.
 */
async function detectBoltTilePlaceholderHrefs(page) {
  return await page.evaluate(({ excludedSelector, hostSelector, promoSelector, includeAll }) => {
    // Broad selector for bolt tile web components
    const BOLT_TILE_SELECTOR = 'bolt-tile, bolt-card-tile, bolt-tile-cta, bolt-linked-list-item';

    function isInsideExcluded(el) {
      if (includeAll) return false;
      if (el.closest(promoSelector)) return false;
      const excContainers = Array.from(document.querySelectorAll(excludedSelector));
      const excHosts      = Array.from(document.querySelectorAll(hostSelector));
      if (excContainers.length > 0) {
        if (el.closest(excludedSelector)) return true;
        if (excContainers.some(c => c.contains(el))) return true;
      }
      if (excHosts.length > 0) {
        if (el.closest(hostSelector)) return true;
        if (excHosts.some(h => h.contains(el))) return true;
      }
      return false;
    }

    const results = [];
    const seen = new Set();

    // Light-DOM bolt tiles
    const boltTiles = Array.from(document.querySelectorAll(BOLT_TILE_SELECTOR));
    for (const tile of boltTiles) {
      if (isInsideExcluded(tile)) continue;
      // Look for any anchor directly on the tile element OR nested inside it
      const anchors = [tile, ...Array.from(tile.querySelectorAll('a'))].filter(
        el => el.tagName.toLowerCase() === 'a'
      );
      for (const anchor of anchors) {
        const rawHref = anchor.getAttribute('href');
        if (rawHref !== '/') continue;                          // only placeholder "/"
        if (anchor.getAttribute('data-expected-link') === 'true') continue; // already annotated
        const text = (
          anchor.textContent?.trim() ||
          anchor.getAttribute('aria-label') ||
          tile.getAttribute('data-title') ||
          tile.getAttribute('title') ||
          'Unnamed bolt tile'
        ).substring(0, 120);
        const key = text + '|' + anchor.outerHTML.substring(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          tagName:     anchor.tagName.toLowerCase(),
          text,
          tileTag:     tile.tagName.toLowerCase(),
          outerHtml:   anchor.outerHTML.substring(0, 300),
          tileOuterHtml: tile.outerHTML.substring(0, 300)
        });
      }
    }

    return results;
  }, {
    excludedSelector: EXCLUDED_CONTAINER_SELECTOR,
    hostSelector:     EXCLUDED_HOST_SELECTOR,
    promoSelector:    INCLUDED_PANEL_SELECTOR,
    includeAll:       REPORT_ALL_MODE
  });
}

/**
 * Detect <span> elements that are rendered IN PLACE OF an expected <a> link.
 *
 * When a CMS link is missing or broken, the ngx-web-link Angular component may
 * fall back to rendering a <span> instead of an <a href="..."> — the text is
 * visible on the page but the element is NOT clickable or navigable.
 *
 * Two detection strategies:
 *   1. .ngx-web-link wrappers with NO inner <a[href]> but WITH inner <span>
 *      → broken CMS link fell back to a span (primary pattern)
 *   2. Spans inside header/nav <li> items that are NOT inside an <a> and
 *      whose CSS cursor is "pointer" — visually look clickable but aren't
 *
 * Returns an array of plain objects describing each offending element.
 */
async function detectSpanBrokenLinks(page) {
  return await page.evaluate(({ excludedSelector, hostSelector, promoSelector, ngxSelector, isMobileMode, includeAll }) => {
    const results = [];
    const seenElements = new WeakSet(); // track actual DOM node refs — prevents overlapping-ancestor duplicates
    const seenText    = new Set();      // secondary guard: one entry per unique text per page

    function isInsideExcluded(el) {
      if (includeAll) return false;
      // Exception: bolt-header-panel-promos content is always validated
      if (el.closest(promoSelector)) return false;
      const excContainers = Array.from(document.querySelectorAll(excludedSelector));
      const excHosts      = Array.from(document.querySelectorAll(hostSelector));
      if (excContainers.length > 0) {
        if (el.closest(excludedSelector)) return true;
        if (excContainers.some(c => c.contains(el))) return true;
      }
      if (excHosts.length > 0) {
        if (el.closest(hostSelector)) return true;
        if (excHosts.some(h => h.contains(el))) return true;
      }
      return false;
    }

    // Skip CSS-hidden elements (e.g. mobile nav hidden at desktop viewport)
    function isHidden(el) {
      if (isMobileMode) return false; // in mobile mode nothing is pre-hidden
      let node = el;
      while (node && node !== document.documentElement) {
        const s = window.getComputedStyle(node);
        if (s.display === 'none' || s.visibility === 'hidden') return true;
        node = node.parentElement;
      }
      return false;
    }

    // ── Strategy 1: ngx-web-link wrappers that render a <span> instead of <a> ──
    // light DOM only (bolt-header-wc shadow content is handled by extractShadowPanelLinks)
    const ngxWrappers = Array.from(document.querySelectorAll(ngxSelector));
    for (const wrapper of ngxWrappers) {
      if (isInsideExcluded(wrapper)) continue;
      if (isHidden(wrapper)) continue;
      // Skip if already annotated as an expected/intentional broken link
      if (wrapper.getAttribute('data-expected-link') === 'true') continue;
      const innerAnchors = Array.from(wrapper.querySelectorAll('a[href]'));
      if (innerAnchors.length > 0) continue; // has a valid anchor — all good
      const innerSpans = Array.from(wrapper.querySelectorAll('span'));
      for (const span of innerSpans) {
        if (seenElements.has(span)) continue;         // same DOM node seen via another wrapper
        seenElements.add(span);
        if (span.getAttribute('data-expected-link') === 'true') continue;
        const text = (span.textContent || '').trim();
        if (!text || text.length < 2) continue;
        if (seenText.has('ngx:' + text)) continue;
        seenText.add('ngx:' + text);
        results.push({
          text: text.substring(0, 120),
          tagName: 'span',
          location: 'ngx-web-link wrapper (no <a> rendered)',
          outerHtml: span.outerHTML.substring(0, 300),
          wrapperHtml: wrapper.outerHTML.substring(0, 300)
        });
      }
    }

    // ── Strategy 2: header/nav <li> spans + shadow panel spans ───────────────
    const navAreas = Array.from(document.querySelectorAll(
      'nav, header, [role="navigation"], [class*="header"], [class*="nav-"], [class*="menu"]'
    ));
    for (const nav of navAreas) {
      if (isInsideExcluded(nav)) continue;
      // li > span, or spans with pointer cursor inside nav-like containers
      const candidateSpans = Array.from(
        nav.querySelectorAll('li > span, li span[class], [class*="nav"] span, [class*="menu"] span')
      );
      for (const span of candidateSpans) {
        if (seenElements.has(span)) continue;         // already visited from an overlapping ancestor
        seenElements.add(span);
        if (isInsideExcluded(span)) continue;
        if (isHidden(span)) continue;                 // skip CSS-hidden (mobile nav in desktop mode)
        if (span.closest('a')) continue;              // already inside an anchor
        if (span.closest(ngxSelector)) continue;      // covered by strategy 1
        if (span.getAttribute('data-expected-link') === 'true') continue;
        const text = (span.textContent || '').trim();
        if (!text || text.length < 2) continue;
        const style = window.getComputedStyle(span);
        const isPointer   = style.cursor === 'pointer';
        const isInNavList = !!span.closest('ul, ol, nav, [role="menu"], [role="menubar"], [role="navigation"]');
        if (!isPointer && !isInNavList) continue;
        if (seenText.has('nav:' + text)) continue;    // deduplicate by text within page
        seenText.add('nav:' + text);
        results.push({
          text: text.substring(0, 120),
          tagName: 'span',
          location: 'header/nav area (span in nav list — not clickable)',
          outerHtml: span.outerHTML.substring(0, 300),
          wrapperHtml: ''
        });
      }
    }

    return results;
  }, {
    excludedSelector: EXCLUDED_CONTAINER_SELECTOR,
    hostSelector:     EXCLUDED_HOST_SELECTOR,
    promoSelector:    INCLUDED_PANEL_SELECTOR,
    ngxSelector:      NGX_WEB_LINK_WRAPPER_SELECTOR,
    isMobileMode:     MOBILE_MODE,
    includeAll:       REPORT_ALL_MODE
  });
}

// ==================== LINK VALIDATION ====================

/**
 * Validate if an anchor exists in the page
 */
async function validateAnchor(page, anchorId) {
  try {
    const exists = await page.evaluate((id) => {
      const element = document.getElementById(id) || document.querySelector(`[name="${id}"]`);
      return element !== null;
    }, anchorId);
    return exists;
  } catch (error) {
    return false;
  }
}

/**
 * Check for anchor issues (empty, malformed, or missing anchors)
 */
function checkAnchorIssues(url) {
  if (!url.includes('#')) {
    return { hasAnchor: false, issue: 'No' };
  }

  const parts = url.split('#');
  if (parts.length !== 2) {
    return { hasAnchor: true, issue: 'Yes', reason: 'Malformed anchor (multiple # symbols)' };
  }

  const anchorId = parts[1];
  
  // Check for empty anchor
  if (!anchorId || anchorId.trim() === '') {
    return { hasAnchor: true, issue: 'Yes', reason: 'Empty anchor (missing anchor ID)' };
  }

  // Check for invalid characters (basic validation)
  if (!/^[a-zA-Z0-9_\-.:]+$/.test(anchorId)) {
    return { hasAnchor: true, issue: 'Warning', reason: 'Anchor contains invalid characters' };
  }

  return { hasAnchor: true, issue: 'No', anchorId: anchorId };
}

/**
 * Validate a single link by making an HTTP request.
 * Returns { statusCode, error, redirected, contentIssue }.
 * For external links, falls back to browser navigation if API request fails or returns 4xx/5xx.
 */
async function validateLink(requestContext, absoluteUrl, retries = MAX_RETRIES, isExternal = false, browserContext = null) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await requestContext.get(absoluteUrl, {
        timeout: REQUEST_TIMEOUT,
        failOnStatusCode: false, // we want to capture status even if 4xx/5xx
      });
      const statusCode = response.status();
      
      const redirected = (statusCode >= 300 && statusCode < 400) ? 'Yes' : 'No';
      const contentType = (response.headers()['content-type'] || '').toLowerCase();

      if (statusCode === 429) {
        if (attempt < retries) {
          console.log(`   ⏳ Rate limited (HTTP 429) for ${absoluteUrl}; retrying ${attempt}/${retries}`);
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        return { statusCode, error: 'Rate limited: HTTP 429 Too Many Requests', redirected, contentIssue: false, rateLimited: true };
      }

      // Guard against false PASS for PDF links that return an HTML error page
      // (e.g., "Application Unavailable") with HTTP 200.
      const isPdfUrl = /\.pdf(?:$|[?#])/i.test(absoluteUrl);
      if (isPdfUrl && statusCode >= 200 && statusCode < 400) {
        if (!contentType.includes('pdf')) {
          let contentError = `PDF URL returned unexpected content-type: ${contentType || 'unknown'}`;
          if (contentType.includes('html') || contentType === '') {
            try {
              const body = (await response.text()).toLowerCase();
              if (body.includes('application unavailable')) {
                contentError = 'PDF URL returned Application Unavailable page';
              }
            } catch (_) {
              // Leave contentError as-is if body cannot be read.
            }
          }
          return { statusCode, error: contentError, redirected, contentIssue: true };
        }
      }

      if (!isPdfUrl && statusCode >= 200 && statusCode < 400 && contentType.includes('html')) {
        try {
          const body = await response.text();
          const normalizedBody = normalizeErrorText(body);
          const htmlErrorPattern = PAGE_ERROR_MESSAGES.find(msg => normalizedBody.includes(
            normalizeErrorText(msg)
          ));
          if (htmlErrorPattern) {
            if (isRateLimitErrorMessage(htmlErrorPattern)) {
              if (attempt < retries) {
                console.log(`   ⏳ Rate-limit page detected for ${absoluteUrl}; retrying ${attempt}/${retries}`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
                continue;
              }
              return { statusCode, error: `Rate limited: HTML page contains ${htmlErrorPattern}`, redirected, contentIssue: false, rateLimited: true };
            }
            return { statusCode, error: `HTML page contains error message: ${htmlErrorPattern}`, redirected, contentIssue: true };
          }
        } catch (_) {
          // Leave HTTP result unchanged if the body cannot be inspected.
        }
      }

      // For external links with 4xx/5xx errors, try browser fallback
      if (isExternal && browserContext && statusCode >= 400 && attempt === 1) {
        let validationPage = null;
        try {
          console.log(`   🔄 External link returned HTTP ${statusCode}, trying browser fallback...`);
          validationPage = await browserContext.newPage();
          const browserResponse = await validationPage.goto(absoluteUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: REQUEST_TIMEOUT 
          });
          const browserStatusCode = browserResponse.status();
          const browserRedirected = (browserStatusCode >= 300 && browserStatusCode < 400) ? 'Yes' : 'No';
          console.log(`   ✅ Browser fallback: HTTP ${browserStatusCode}`);
          await validationPage.close();
          // Only use browser result if it's better (2xx/3xx)
          if (browserStatusCode >= 200 && browserStatusCode < 400) {
            return { statusCode: browserStatusCode, error: null, redirected: browserRedirected, contentIssue: false };
          }
        } catch (browserError) {
          if (validationPage) await validationPage.close().catch(() => {});
          console.log(`   ⚠️ Browser fallback also failed: ${browserError.message}`);
        }
      }

      return { statusCode: statusCode, error: null, redirected: redirected, contentIssue: false };
    } catch (error) {
      if (attempt === retries) {
        // Fallback for external links: try with browser navigation in a new tab
        if (isExternal && browserContext) {
          let validationPage = null;
          try {
            console.log(`   🔄 External link failed with API request, trying browser fallback...`);
            // Create a new page for validation (won't disrupt main page)
            validationPage = await browserContext.newPage();
            const response = await validationPage.goto(absoluteUrl, { 
              waitUntil: 'domcontentloaded', 
              timeout: REQUEST_TIMEOUT 
            });
            const statusCode = response.status();
            const redirected = (statusCode >= 300 && statusCode < 400) ? 'Yes' : 'No';
            console.log(`   ✅ Browser fallback successful: HTTP ${statusCode}`);
            await validationPage.close();
            return { statusCode: statusCode, error: null, redirected: redirected, contentIssue: false };
          } catch (browserError) {
            if (validationPage) await validationPage.close().catch(() => {});
            return { statusCode: null, error: error.message, redirected: 'N/A', contentIssue: false };
          }
        }
        return { statusCode: null, error: error.message, redirected: 'N/A', contentIssue: false };
      }
      console.log(`   Retry ${attempt} for ${absoluteUrl}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return { statusCode: null, error: 'Max retries exceeded', redirected: 'N/A', contentIssue: false };
}
 
/**
 * Determine if a link should be skipped (anchor, javascript, etc.)
 */
function shouldSkipLink(href) {
  if (!href || href.trim() === '') return true;
  const trimmed = href.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
    return true;
  }
  return false;
}

function isExpectedQuoteDestination(url) {
  if (!url || url === 'about:blank') return false;
  return /(quote|estimate|getaquote|bold[-_]?penguin|api|semsee|business_insurance)/i.test(url);
}

async function validateMissingHrefClickNavigation(page, requestContext, selector, baseUrl, linkText = '', rawHref = '') {
  const originalUrl = page.url();
  let popupPage = null;
  let finalUrl = '';
  let statusCode = null;
  let redirected = 'No';

  try {
    let locator = page.locator(selector).first();
    let count = await locator.count().catch(() => 0);
    if (count === 0 && linkText) {
      const fallbackSelector = await page.evaluate(({ text, href }) => {
        const normalizedText = text.trim().replace(/\s+/g, ' ').toLowerCase();
        const anchors = Array.from(document.querySelectorAll('a'));
        const matchingAnchor = anchors.find(anchor => {
          const anchorText = (anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '').trim().replace(/\s+/g, ' ').toLowerCase();
          const anchorHref = anchor.getAttribute('href') || '';
          const hrefMatches = href ? anchorHref === href : (!anchor.hasAttribute('href') || anchorHref === '' || anchorHref === '#');
          return anchorText === normalizedText && hrefMatches;
        });
        if (!matchingAnchor) return '';

        const validatorId = `click-fallback-${Math.random().toString(36).slice(2)}`;
        matchingAnchor.setAttribute('data-link-validator-click-id', validatorId);
        return `[data-link-validator-click-id="${validatorId}"]`;
      }, { text: linkText, href: rawHref });

      if (!fallbackSelector) {
        const boltButtonFallbackSelector = await page.evaluate(({ text, href }) => {
          const normalizedText = text.trim().replace(/\s+/g, ' ').toLowerCase();
          const boltButtons = Array.from(document.querySelectorAll('bolt-button'));
          const matchingButton = boltButtons.find(button => {
            const buttonText = (button.textContent || button.getAttribute('aria-label') || button.title || '').trim().replace(/\s+/g, ' ').toLowerCase();
            if (buttonText !== normalizedText) return false;

            const shadowAnchor = button.shadowRoot?.querySelector('a[href]');
            if (!shadowAnchor) return href ? false : true;

            const anchorHref = shadowAnchor.getAttribute('href') || '';
            return href ? anchorHref === href : anchorHref === '#' || anchorHref === '';
          });
          if (!matchingButton) return '';

          const validatorId = `click-fallback-bolt-button-${Math.random().toString(36).slice(2)}`;
          matchingButton.setAttribute('data-link-validator-click-id', validatorId);
          return `[data-link-validator-click-id="${validatorId}"]`;
        }, { text: linkText, href: rawHref });

        if (boltButtonFallbackSelector) {
          locator = page.locator(boltButtonFallbackSelector).first();
          count = await locator.count().catch(() => 0);
        }
      }

      if (fallbackSelector) {
        locator = page.locator(fallbackSelector).first();
        count = await locator.count().catch(() => 0);
      }
    }

    if (count === 0) {
      return { passed: false, error: 'Click target not found after link extraction' };
    }

    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});

    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
    await locator.click({ timeout: 10000 });

    const popup = await popupPromise;
    const navigationResponse = await navigationPromise;

    if (popup) {
      popupPage = popup;
      await popupPage.waitForLoadState('domcontentloaded', { timeout: REQUEST_TIMEOUT }).catch(() => {});
      finalUrl = popupPage.url();
    } else {
      if (navigationResponse) {
        statusCode = navigationResponse.status();
        redirected = navigationResponse.request().redirectedFrom() ? 'Yes' : 'No';
      }
      await page.waitForTimeout(1500);
      finalUrl = page.url();
    }

    if (!finalUrl || finalUrl === originalUrl) {
      return { passed: false, error: 'Click did not navigate or open a quote page', finalUrl: finalUrl || originalUrl };
    }

    if (!isExpectedQuoteDestination(finalUrl)) {
      return { passed: false, error: `Click navigated to unexpected destination: ${finalUrl}`, finalUrl };
    }

    if (!statusCode && requestContext && /^https?:\/\//i.test(finalUrl)) {
      const validation = await validateLink(requestContext, finalUrl, MAX_RETRIES, new URL(finalUrl).hostname !== new URL(baseUrl).hostname);
      statusCode = validation.statusCode;
      redirected = validation.redirected || redirected;
      if (validation.error) {
        return { passed: false, error: validation.error, finalUrl, statusCode, redirected };
      }
    }

    const httpOk = !statusCode || (statusCode >= 200 && statusCode < 400);
    return {
      passed: httpOk,
      error: httpOk ? '' : `Quote destination returned HTTP ${statusCode}`,
      finalUrl,
      statusCode,
      redirected
    };
  } catch (error) {
    return { passed: false, error: error.message, finalUrl };
  } finally {
    if (popupPage) {
      await popupPage.close().catch(() => {});
    }
    if (page.url() !== originalUrl) {
      await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT }).catch(() => {});
      await waitForPageLoad(page).catch(() => {});
    }
  }
}
 
// ==================== MAIN EXECUTION ====================
 
(async () => {
  startTime = new Date();
  console.log('🚀 Starting Link Validation...\n');
 
  const urls = readUrlsFromCsv();
  
  let urlIndex = 0;
  let batchNumber = 0;

  try {
    while (urlIndex < urls.length) {
      batchNumber++;
      const batchStart = urlIndex;
      const batchEnd = Math.min(urlIndex + BATCH_SIZE, urls.length);
      const batchUrls = urls.slice(batchStart, batchEnd);
      
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`📦 BATCH ${batchNumber} - Processing URLs ${batchStart + 1} to ${batchEnd} of ${urls.length}`);
      console.log(`${'═'.repeat(70)}\n`);

      const browser = await chromium.launch({ 
        headless: true,
        args: ['--disable-blink-features=AutomationControlled']
      });

      try {
        for (const baseUrl of batchUrls) {
          let context = null;
          let page = null;
          let requestContext = null;

          urlIndex++;
          console.log(`\n🔍 [${urlIndex}/${urls.length}] Testing URL: ${baseUrl}`);
          console.log('─'.repeat(60));

          try {
            // Use a fresh browser context per URL to avoid cookie/session contamination
            // between different environments (e.g., UAT_DXA vs UAT-Angular).
            context = await browser.newContext({
              ignoreHTTPSErrors: true,
              userAgent: MOBILE_MODE
                ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
                : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              viewport: VIEWPORT,
              isMobile: MOBILE_MODE,
              locale: 'en-US',
              timezoneId: 'America/New_York',
              extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
              }
            });
            page = await context.newPage();
            requestContext = context.request;

            // Navigate to page
            await retryWrapper(async () => {
              await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await waitForPageLoad(page);
            });

            logResult(
              `Navigate to ${baseUrl}`,
              'Page loaded',
              'Page loaded',
              'PASS',
              '',
              0,
              baseUrl,
              '',
              'N/A',
              'N/A',
              'No',
              'Page Navigation',
              'N/A',
              'No'
            );

            const expectedLinksSnapshot = await extractExpectedLinks(page);
 
        // ── Extract links ────────────────────────────────────────────────────
        let links;
        if (UNIFIED_MODE) {
          links = await extractUnifiedLinksStabilized(context, page, baseUrl);
          const mobileOnlyCount = links.filter(l => l.viewportSource === 'Mobile Only').length;
          const bothCount = links.filter(l => l.viewportSource === 'Both').length;
          const desktopOnlyCount = links.filter(l => l.viewportSource === 'Desktop').length;
          console.log(`   🔀 Unified extraction complete: ${links.length} unique links (${desktopOnlyCount} desktop-only, ${bothCount} shared, ${mobileOnlyCount} mobile-only)`);
        } else {
          links = await extractLinksStabilized(page, baseUrl);
        }
        const nonHrefLinks = await extractNonHrefLinks(page, baseUrl);

        // ── Shadow panel links (Playwright-native pierce through closed Shadow DOM) ──
        // bolt-header-wc uses a CLOSED shadow root — standard JS querySelectorAll
        // cannot access it. Use Playwright's '>>' combinator to pierce it and extract
        // links from .bolt-header-panel-promos and .bolt-header-panel-footer.
        const shadowPanelLinks = await extractShadowPanelLinks(page, baseUrl);
        const shadowPanelCount = shadowPanelLinks._shadowPanelCount || 0;
        if (shadowPanelCount > 0) {
          // Deduplicate against links already found in light DOM
          const existingHrefs = new Set(links.map(l => l.href));
          const newShadowLinks = shadowPanelLinks.filter(l => !existingHrefs.has(l.href));
          links.push(...newShadowLinks);
          console.log(`   🔍 Shadow DOM (bolt-header-wc): ${shadowPanelCount} panel link(s) found, ${newShadowLinks.length} new (not in light DOM)`);
        }

        const boltTileShadowLinks = await extractBoltTileShadowLinks(page, baseUrl);
        const boltTileShadowCount = boltTileShadowLinks._boltTileShadowCount || 0;
        if (boltTileShadowCount > 0) {
          const existingKeys = new Set(links.map(l => buildLinkKey(l)));
          const newBoltTileLinks = boltTileShadowLinks.filter(l => !existingKeys.has(buildLinkKey(l)));
          links.push(...newBoltTileLinks);
          console.log(`   🔍 Shadow DOM (bolt-tile): ${boltTileShadowCount} tile link(s) found, ${newBoltTileLinks.length} new (not in light DOM)`);
        }

        const boltButtonShadowLinks = await extractBoltButtonShadowLinks(page, baseUrl);
        const boltButtonShadowCount = boltButtonShadowLinks._boltButtonShadowCount || 0;
        if (boltButtonShadowCount > 0) {
          const existingKeys = new Set(links.map(l => buildLinkKey(l)));
          const newBoltButtonLinks = boltButtonShadowLinks.filter(l => !existingKeys.has(buildLinkKey(l)));
          links.push(...newBoltButtonLinks);
          console.log(`   🔍 Shadow DOM (bolt-button): ${boltButtonShadowCount} button link(s) found, ${newBoltButtonLinks.length} new (not in light DOM)`);
        }

        const excludedCount        = links._excludedCount  || 0;
        const containerFound       = links._containerFound || 0;
        const nonHrefCount         = nonHrefLinks._nonHrefCount || 0;
        const responsiveHiddenCount = links._responsiveHiddenCount || 0;
        const selectExpandedCount  = links._selectExpandedCount || 0;
        const promoMapExpandedCount = links._promoMapExpandedCount || 0;
        const stickyCtaExpandedCount = links._stickyCtaExpandedCount || 0;
        const accordionExpandedCount = links._accordionExpandedCount || 0;

        if (!UNIFIED_MODE) {
          if (REPORT_ALL_MODE) {
            console.log(`   Found ${links.length} links | ✅ report-all mode includes links from all containers (no exclusion applied)`);
          } else if (containerFound > 0) {
            console.log(`   Found ${links.length} links | ⛔ Excluded ${excludedCount} links from [${EXCLUDED_CONTAINER_SELECTOR}] / [${EXCLUDED_HOST_SELECTOR}] (${containerFound} container(s) found)`);
          } else {
            console.log(`   Found ${links.length} links (bolt-header-wc--menuBar-wrapper not found on this page — no links excluded)`);
          }
          if (!REPORT_ALL_MODE && !MOBILE_MODE && responsiveHiddenCount > 0) {
            console.log(`   📵 Skipped ${responsiveHiddenCount} CSS-hidden (mobile-only) link(s) in desktop mode — run with --mobile to include them`);
          }
        }
        if (selectExpandedCount > 0) {
          console.log(`   🔽 Expanded ${selectExpandedCount} <select> option link(s) from select-driven Go button(s)`);
        }
        if (promoMapExpandedCount > 0) {
          console.log(`   🗺️ Expanded ${promoMapExpandedCount} visual promo map component(s) before link extraction`);
        }
        if (stickyCtaExpandedCount > 0) {
          console.log(`   📌 Expanded ${stickyCtaExpandedCount} sticky CTA component(s) before link extraction`);
        }
        if (accordionExpandedCount > 0) {
          console.log(`   🪗 Expanded ${accordionExpandedCount} accordion section(s) before link extraction`);
        }
        if (nonHrefCount > 0) {
          console.log(`   Found ${nonHrefCount} non-href clickable element(s) (buttons, role="button", click handlers)`);
        }

        // Log Angular ngx-web-link pattern statistics
        const angularValidLinks = links.filter(l => l.angularClassification === 'angular-valid').length;
        const angularExceptionLinks = links.filter(l => l.angularClassification === 'angular-exception').length;
        const richTextLinks = links.filter(l => l.angularClassification === 'rich-text-content').length;
        const totalAngularPatterns = angularValidLinks + angularExceptionLinks + richTextLinks;
        if (totalAngularPatterns > 0) {
          console.log(`   🅰️  Angular Patterns: ${angularValidLinks} valid (ngx-web-link), ${angularExceptionLinks} exceptions (special attrs), ${richTextLinks} rich-text content`);
        }

        // ── Step 1–5: data-expected-link detection ────────────────────────────
  const visualPromoExpectedLinks = await collectVisualPromoMapExpectedLinks(page);
  const expectedLinks = mergeExpectedLinkArrays(expectedLinksSnapshot, visualPromoExpectedLinks);
        const expectedCount = expectedLinks._expectedCount || 0;

        if (expectedCount > 0) {
          console.log(`   Found ${expectedCount} element(s) marked data-expected-link="true"`);
        }

        // Process expected links: INFO for clean elements, FAIL for accessibility violations
        for (const el of expectedLinks) {
          if (!el.accessibilityViolations) continue; // safety guard

          // Validate Angular ngx-web-link wrapper pattern for expected links
          // Expected links are exception elements, so they should follow the angular-exception pattern
          const expectedLinkPattern = {
            angularClassification: 'angular-exception',
            hasNgxWrapper: el.hasNgxWrapper || false,
            hasSpecialAttrs: true,  // data-expected-link is the special attribute
            isRichText: false,
            linkText: el.text,
            href: el.linkStatus
          };
          const expectedLinkValidation = validateAngularLinkPattern(expectedLinkPattern);
          if (!expectedLinkValidation.isValid) {
            patternViolations.push({
              url: baseUrl,
              linkText: `[Expected] ${el.text}`,
              href: el.linkStatus,
              angularClassification: 'angular-exception',
              violations: expectedLinkValidation.violations,
              message: expectedLinkValidation.message
            });
            console.log(`   ${expectedLinkValidation.message}`);
          }

          if (el.isAccessibilityClean) {
            // Step 3 & 4: Scan + report as INFO — never click, never break the build
            logResult(
              el.text.substring(0, 50),
              'Non-interactive placeholder (data-expected-link)',
              `Expected link placeholder — status: "${el.linkStatus}"`,
              'INFO',
              `Element marked data-expected-link="true". Reason: ${el.linkStatus}. Tag: <${el.tagName}>. No interaction expected.`,
              0,
              baseUrl,
              '',          // no navigated URL
              'Expected Link',
              'N/A',
              'No',
              el.text,
              'N/A',
              'No',
              'Expected Link',
              'angular-exception',  // Angular classification
              el.hasNgxWrapper,     // Has ngx wrapper
              true,                 // Has special attrs (data-expected-link)
              false                 // Not rich text
            );
            console.log(`   ℹ️ Expected link: "${el.text.substring(0, 60)}" [status: ${el.linkStatus}]`);
          } else {
            // Step 5: Accessibility regression detected — this IS a failure
            const violationDetail = el.accessibilityViolations.join(' | ');
            logResult(
              el.text.substring(0, 50),
              'Non-interactive placeholder — no tabindex, no role="link", not an <a>',
              `Accessibility regression on expected-link: ${violationDetail}`,
              'FAIL',
              `ACCESSIBILITY REGRESSION: Element has data-expected-link="true" but violates accessibility rules. Violations: ${violationDetail}`,
              0,
              baseUrl,
              '',
              'Expected Link (A11Y Fail)',
              'N/A',
              'No',
              el.text,
              'N/A',
              'No',
              'Expected Link (A11Y Fail)',
              'angular-exception',  // Angular classification
              el.hasNgxWrapper,     // Has ngx wrapper
              true,                 // Has special attrs (data-expected-link)
              false                 // Not rich text
            );
            console.log(`   ❌ Expected link ACCESSIBILITY REGRESSION: "${el.text.substring(0, 60)}" — ${violationDetail}`);
          }
        }
        // ── End data-expected-link processing ────────────────────────────────

        // ── Unannotated missing-href detection ───────────────────────────────
        // Detect any <a> tags that have no href AND no data-expected-link="true".
        // These are genuine broken-link defects — report each as FAIL.
        const unannotatedMissing = await detectUnannotatedMissingHrefs(page);
        if (unannotatedMissing.length > 0) {
          console.log(`   ❌ Found ${unannotatedMissing.length} unannotated <a> element(s) with missing/empty href`);
        }
        for (const el of unannotatedMissing) {
          const hrefDesc = el.hasHref ? 'empty href (href="")' : 'missing href (no href attribute)';
          _pendingSourceHref = el.hasHref ? 'empty href' : 'missing href';
          _pendingSourceUrl = _pendingSourceHref;
          _pendingSourceComponent = el.sourceComponent || 'N/A';
          _pendingSourceElement = el.sourceElement || el.tagName || 'N/A';
          if (el.shouldClickValidate) {
            const clickValidation = await validateMissingHrefClickNavigation(page, requestContext, el.clickSelector, baseUrl, el.text, el.hasHref ? '' : '');
            if (clickValidation.passed) {
              const destinationType = new URL(clickValidation.finalUrl).hostname === new URL(baseUrl).hostname ? 'Internal' : 'External';
              logResult(
                el.text.substring(0, 50),
                'JavaScript click navigates to quote destination with HTTP 2xx/3xx',
                clickValidation.statusCode ? `HTTP ${clickValidation.statusCode}` : `Navigated to ${clickValidation.finalUrl}`,
                'PASS',
                '',
                0,
                baseUrl,
                clickValidation.finalUrl,
                destinationType,
                clickValidation.statusCode ? clickValidation.statusCode.toString() : 'N/A',
                clickValidation.redirected || 'No',
                el.text,
                'Same Window',
                'No',
                'JS Navigated Link',
                'angular-exception',
                false,
                true,
                false
              );
              _pendingSourceHref = 'N/A';
              _pendingSourceUrl = 'N/A';
              _pendingSourceComponent = 'N/A';
              _pendingSourceElement = 'N/A';
              console.log(`   ✅ JS click-validated missing-href CTA: "${el.text.substring(0, 60)}" → ${clickValidation.finalUrl}`);
              continue;
            }

            console.log(`   ⚠️ JS click validation failed for missing-href CTA: "${el.text.substring(0, 60)}" — ${clickValidation.error}`);
          }

          logResult(
            el.text.substring(0, 50),
            'All <a> elements must have a valid href or carry data-expected-link="true"',
            `<a> tag has ${hrefDesc} and is not annotated with data-expected-link="true"`,
            'FAIL',
            `MISSING LINK: <${el.tagName}> "${el.text.substring(0, 80)}" has ${hrefDesc}. ` +
            `Add data-expected-link="true" data-link-status="missing-href" if intentional, otherwise provide a valid href. ` +
            `HTML: ${el.outerHtml}`,
            0,
            baseUrl,
            '',          // no navigated URL
            'Missing Href',
            'N/A',
            'No',
            el.text,
            'N/A',
            'No',
            'Missing Href',
            'standard',  // Angular classification
            false,       // No ngx wrapper
            false,       // No special attrs
            false        // Not rich text
          );
          _pendingSourceHref = 'N/A';
          _pendingSourceUrl = 'N/A';
          _pendingSourceComponent = 'N/A';
          _pendingSourceElement = 'N/A';
          console.log(`   ❌ Missing href: "${el.text.substring(0, 60)}" [${hrefDesc}] — ${el.outerHtml.substring(0, 100)}`);
        }
        // ── End unannotated missing-href detection ───────────────────────────

        // ── Bolt tile placeholder href="/" detection ─────────────────────────
        // bolt-tile / bolt-card-tile components emit  <a href="/">  when no URL
        // has been configured in the CMS.  This is a broken tile link — the tile
        // text is visible but clicking it just reloads the homepage instead of
        // navigating to the intended destination.
        const boltTilePlaceholders = await detectBoltTilePlaceholderHrefs(page);
        if (boltTilePlaceholders.length > 0) {
          console.log(`   ❌ Found ${boltTilePlaceholders.length} bolt tile(s) with placeholder href="/"`);
        }
        for (const el of boltTilePlaceholders) {
          logResult(
            el.text.substring(0, 50),
            'bolt-tile must have a configured destination URL (not href="/")',
            `<${el.tileTag}> has unconfigured link — anchor resolves to href="/"`,
            'FAIL',
            `BOLT TILE BROKEN LINK: <${el.tileTag}> "${el.text.substring(0, 80)}" has href="/" which is a placeholder indicating the URL has not been set in the CMS. ` +
            `Configure the correct URL in Tridion/CMS for this tile. ` +
            `Anchor HTML: ${el.outerHtml} | Tile HTML: ${el.tileOuterHtml.substring(0, 200)}`,
            0,
            baseUrl,
            '',              // no valid navigated URL
            'Bolt Tile Broken Link',
            'N/A',
            'No',
            el.text,
            'N/A',
            'No',
            'Bolt Tile Broken Link',
            'standard',
            false,
            false,
            false
          );
          console.log(`   ❌ Bolt tile placeholder href="/": "${el.text.substring(0, 60)}" [<${el.tileTag}>]`);
        }
        // ── End bolt tile placeholder detection ──────────────────────────────

        // ── Span-as-broken-link detection ────────────────────────────────────
        // Finds <span> elements that appear in place of expected <a> links:
        // link text is visible on the page but the element has no anchor/href
        // and is not navigable. Covers ngx-web-link fallbacks and header/nav spans.
        const spanBrokenLinks = await detectSpanBrokenLinks(page);
        if (spanBrokenLinks.length > 0) {
          console.log(`   ❌ Found ${spanBrokenLinks.length} <span> element(s) rendered instead of a clickable link — link text present but element has no anchor/href`);
        }
        for (const el of spanBrokenLinks) {
          logResult(
            el.text.substring(0, 50),
            'Link must be rendered as <a href="..."> — not a non-clickable <span>',
            `<span> rendered instead of <a> in ${el.location}`,
            'FAIL',
            `Link text "${el.text.substring(0, 80)}" is not clickable — rendered as a <span> instead of an <a href="..."> element. ` +
            `Location: ${el.location}. ` +
            `The link text is present in the page but the element is non-navigable (no anchor tag, no href). ` +
            `HTML: ${el.outerHtml}${el.wrapperHtml ? ' | Wrapper: ' + el.wrapperHtml : ''}`,
            0,
            baseUrl,
            '',              // no navigated URL
            'Span Broken Link',
            'N/A',
            'No',
            el.text,
            'N/A',
            'No',
            'Span Broken Link',
            'angular-exception',
            true,            // inside ngx-web-link wrapper (strategy 1) or nav area
            false,
            false
          );
          console.log(`   ❌ Non-clickable span (link text present but no anchor): "${el.text.substring(0, 60)}" [${el.location}]`);
        }
        // ── End span-as-broken-link detection ───────────────────────────────

        // Combine both href and non-href links for validation
        const allLinks = [...links, ...nonHrefLinks];
        console.log(`   📌 Coverage audit: href-links=${links.length}, non-href-clickables=${nonHrefLinks.length}, combined=${allLinks.length}`);
        
        if (allLinks.length === 0) {
          logResult(
            'Link extraction',
            'At least one navigable element',
            'No links or clickable elements found',
            'SKIP',
            'No navigable elements to validate',
            0,
            baseUrl,
            '',
            'N/A',
            'N/A',
            'No',
            'N/A',
            'N/A',
            'No'
          );
          continue;
        }
 
        // Validate each link and non-href clickable element
        for (let i = 0; i < allLinks.length; i++) {
          const link = allLinks[i];
          // Tag every logResult call in this iteration with the link's viewport source
          _pendingViewportSource = link.viewportSource || 'N/A';
          const { href, rawHref, text, target, clickableType, navigationSource } = link;
          _pendingSourceHref = rawHref || href || 'N/A';
          _pendingSourceUrl = resolveSourceUrl(_pendingSourceHref, baseUrl);
          _pendingSourceComponent = link.sourceComponent || 'N/A';
          _pendingSourceElement = link.sourceElement || 'N/A';
          const stepDesc = `${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`;

          // ========== SPECIAL HANDLING FOR NON-HREF CLICKABLE ELEMENTS ==========
          // If this is a button/role=button/onclick without a detected URL source, log as INFO (not testable)
          if (clickableType && !navigationSource) {
            const elementTypeLabel = link.elementType || 'Button link';
            logResult(
              stepDesc,
              'Clickable element present',
              `Found ${elementTypeLabel} (${clickableType}) - no URL detected`,
              'INFO',
              `Non-href clickable element found on page. Uses event handler for navigation.`,
              0,
              baseUrl,
              '', // No navigated link
              elementTypeLabel,
              'N/A', // No status code
              'No',
              text,
              target || 'N/A',
              'No', // No anchor
              elementTypeLabel
            );
            console.log(`   ℹ️ Non-href clickable: ${stepDesc} (${clickableType})`);
            continue;
          }

          // If this is a button with a detected URL attribute, treat it like a regular link below
          // (falls through to normal validation)
          // ========== END SPECIAL HANDLING ==========

          // Exclude links from report (tel:, mailto:, specific text patterns, etc.)
          // These are completely skipped from logging to the results
          // Use rawHref (getAttribute) for protocol/prefix checks since link.href resolves relative URLs
          if (shouldExcludeFromReport(rawHref || href, text)) {
            console.log(`   ⏭️ Skipped from report: ${stepDesc} | ${rawHref || href}`);
            continue;
          }

          // ========== ANGULAR NGX-WEB-LINK CLASSIFICATION ==========
          // Log Angular pattern detection for Angular environment URLs
          const angularClassification = link.angularClassification || 'standard';
          const hasNgxWrapper = link.hasNgxWrapper || false;
          const hasSpecialAttrs = link.hasSpecialAttrs || false;
          const specialAttrNames = Array.isArray(link.specialAttrNames) ? link.specialAttrNames : [];
          const isRichText = link.isRichText || false;

          if (angularClassification !== 'standard') {
            if (angularClassification === 'angular-valid') {
              console.log(`   ✅ Angular Valid: ngx-web-link wrapper detected (no special attributes)`);
            } else if (angularClassification === 'angular-exception') {
              const attrsDisplay = specialAttrNames.length > 0
                ? specialAttrNames.join(', ')
                : (hasSpecialAttrs ? 'special attribute(s) detected' : 'none detected');
              console.log(`   ⚠️ Angular Exception: ngx-web-link wrapper with special attributes [${attrsDisplay}]`);
            } else if (angularClassification === 'rich-text-content') {
              console.log(`   📝 Rich Text Content: No ngx-web-link (expected exception for content-managed link)`);
            }
          }
          // ========== END ANGULAR CLASSIFICATION ==========

          if (link.shouldClickValidate && link.clickSelector) {
            const clickValidation = await validateMissingHrefClickNavigation(page, requestContext, link.clickSelector, baseUrl, text, rawHref || '');
            if (clickValidation.passed) {
              const destinationType = new URL(clickValidation.finalUrl).hostname === new URL(baseUrl).hostname ? 'Internal' : 'External';
              logResult(
                stepDesc,
                'JavaScript click navigates to quote destination with HTTP 2xx/3xx',
                clickValidation.statusCode ? `HTTP ${clickValidation.statusCode}` : `Navigated to ${clickValidation.finalUrl}`,
                'PASS',
                '',
                0,
                baseUrl,
                clickValidation.finalUrl,
                destinationType,
                clickValidation.statusCode ? clickValidation.statusCode.toString() : 'N/A',
                clickValidation.redirected || 'No',
                text,
                target || 'Same Window',
                'No',
                'JS Navigated Link',
                angularClassification,
                hasNgxWrapper,
                hasSpecialAttrs,
                isRichText
              );
              console.log(`   ✅ JS click-validated quote CTA: "${text.substring(0, 60)}" → ${clickValidation.finalUrl}`);
              continue;
            }

            logResult(
              stepDesc,
              'JavaScript click navigates to quote destination with HTTP 2xx/3xx',
              clickValidation.finalUrl ? `Navigated to ${clickValidation.finalUrl}` : 'No quote navigation detected',
              'FAIL',
              clickValidation.error || 'Quote CTA click validation failed',
              0,
              baseUrl,
              clickValidation.finalUrl || href,
              'N/A',
              clickValidation.statusCode ? clickValidation.statusCode.toString() : 'N/A',
              clickValidation.redirected || 'No',
              text,
              target || 'Same Window',
              'No',
              'JS Navigated Link',
              angularClassification,
              hasNgxWrapper,
              hasSpecialAttrs,
              isRichText
            );
            console.log(`   ❌ JS click validation failed for quote CTA: "${text.substring(0, 60)}" — ${clickValidation.error}`);
            continue;
          }

          // Skip non-navigational links
          if (shouldSkipLink(rawHref || href)) {
            if (link.shouldClickValidate && link.clickSelector) {
              const clickValidation = await validateMissingHrefClickNavigation(page, requestContext, link.clickSelector, baseUrl, text, rawHref || '');
              if (clickValidation.passed) {
                const destinationType = new URL(clickValidation.finalUrl).hostname === new URL(baseUrl).hostname ? 'Internal' : 'External';
                logResult(
                  stepDesc,
                  'JavaScript click navigates to quote destination with HTTP 2xx/3xx',
                  clickValidation.statusCode ? `HTTP ${clickValidation.statusCode}` : `Navigated to ${clickValidation.finalUrl}`,
                  'PASS',
                  '',
                  0,
                  baseUrl,
                  clickValidation.finalUrl,
                  destinationType,
                  clickValidation.statusCode ? clickValidation.statusCode.toString() : 'N/A',
                  clickValidation.redirected || 'No',
                  text,
                  target || 'Same Window',
                  'No',
                  'JS Navigated Link',
                  angularClassification,
                  hasNgxWrapper,
                  hasSpecialAttrs,
                  isRichText
                );
                console.log(`   ✅ JS click-validated placeholder-href CTA: "${text.substring(0, 60)}" → ${clickValidation.finalUrl}`);
                continue;
              }

              logResult(
                stepDesc,
                'JavaScript click navigates to quote destination with HTTP 2xx/3xx',
                clickValidation.finalUrl ? `Navigated to ${clickValidation.finalUrl}` : 'No quote navigation detected',
                'FAIL',
                clickValidation.error || 'Quote CTA click validation failed',
                0,
                baseUrl,
                clickValidation.finalUrl || href,
                'N/A',
                clickValidation.statusCode ? clickValidation.statusCode.toString() : 'N/A',
                clickValidation.redirected || 'No',
                text,
                target || 'Same Window',
                'No',
                'JS Navigated Link',
                angularClassification,
                hasNgxWrapper,
                hasSpecialAttrs,
                isRichText
              );
              console.log(`   ❌ JS click validation failed for placeholder-href CTA: "${text.substring(0, 60)}" — ${clickValidation.error}`);
              continue;
            }

            logResult(
              stepDesc,
              'Navigational link',
              `Skipped: ${href}`,
              'SKIP',
              'Non-navigational href',
              0,
              baseUrl,
              href,
              'N/A',
              'N/A',
              'No',
              text,
              'N/A',
              'No',
              link.elementType || 'N/A'
            );
            continue;
          }
 
          // Construct absolute URL
          let absoluteUrl;
          try {
            absoluteUrl = new URL(href, baseUrl).href;
          } catch (error) {
            logResult(
              stepDesc,
              'Valid URL',
              `Invalid URL: ${href}`,
              'FAIL',
              error.message,
              0,
              baseUrl,
              href,
              'N/A',
              'N/A',
              'No',
              text,
              'N/A',
              'No',
              link.elementType || 'N/A'
            );
            continue;
          }
 
          // Determine if link is internal or external
          const baseUrlObj = new URL(baseUrl);
          const absoluteUrlObj = new URL(absoluteUrl);
          const linkType = baseUrlObj.hostname === absoluteUrlObj.hostname ? 'Internal' : 'External';
          const isExternal = linkType === 'External';
          
          // Check for anchor issues (empty, malformed, or missing)
          const anchorCheck = checkAnchorIssues(absoluteUrl);
          let anchorIssue = 'No';
          let anchorErrorMsg = '';
          
          if (anchorCheck.hasAnchor) {
            // If anchor has structural issues (empty, malformed), report immediately
            if (anchorCheck.issue === 'Yes') {
              anchorIssue = 'Yes';
              anchorErrorMsg = ` | ${anchorCheck.reason}`;
              console.log(`   ⚠️ Anchor issue: ${anchorCheck.reason} in ${anchorCheck.anchorId || 'anchor'}`);
            } else if (anchorCheck.issue === 'Warning') {
              anchorIssue = 'Warning';
              anchorErrorMsg = ` | ${anchorCheck.reason}`;
              console.log(`   ⚠️ Anchor warning: ${anchorCheck.reason} in ${anchorCheck.anchorId}`);
            }
          }
          
          // Validate the link (with browser fallback for external links)
          const { statusCode, error, redirected, contentIssue, rateLimited } = await validateLink(requestContext, absoluteUrl, MAX_RETRIES, isExternal, context);
          const isSuccess = statusCode && statusCode >= 200 && statusCode < 400 && !contentIssue;
          const actualMsg = statusCode
            ? (rateLimited ? `HTTP ${statusCode} (rate limited)` : (contentIssue ? `HTTP ${statusCode} (content check failed)` : `HTTP ${statusCode}`))
            : `Error: ${error}`;
          const expectedMsg = 'HTTP 2xx/3xx';

          if (rateLimited) {
            const linkTarget = target === '_blank' ? 'New Window' : (!target || target === '_self') ? 'Same Window' : target;
            logResult(
              stepDesc,
              expectedMsg,
              actualMsg,
              'PASS',
              error || 'Rate limited by target site during automation; not counted as a broken link.',
              0,
              baseUrl,
              absoluteUrl,
              linkType,
              statusCode ? statusCode.toString() : 'N/A',
              redirected || 'No',
              text,
              linkTarget,
              anchorIssue,
              link.elementType || 'HTML link',
              link.angularClassification || 'standard',
              link.hasNgxWrapper || false,
              link.hasSpecialAttrs || false,
              link.isRichText || false
            );
            console.log(`   ✅ Rate limited by automation, not counted as broken: ${stepDesc} | ${absoluteUrl}`);
            continue;
          }
          
          // For internal links with valid anchors on the same page, validate the anchor exists on page
          if (isSuccess && !isExternal && anchorCheck.hasAnchor && anchorCheck.issue === 'No' && linkType === 'Internal') {
            const baseUrlWithoutAnchor = absoluteUrl.split('#')[0];
            const baseUrlPageWithoutHash = new URL(baseUrl).href.split('#')[0];
            
            // Only validate anchor if it's on the same page as we're currently on
            if (baseUrlWithoutAnchor === baseUrlPageWithoutHash) {
              const anchorExists = await validateAnchor(page, anchorCheck.anchorId);
              if (!anchorExists) {
                anchorIssue = 'Yes';
                anchorErrorMsg = ` | Anchor '${anchorCheck.anchorId}' not found on page`;
                console.log(`   ⚠️ Anchor missing: '${anchorCheck.anchorId}' does not exist on page`);
              }
            }
          }
          
          // Determine link target (same window vs new window)
          const linkTarget = target === '_blank' ? 'New Window' : (!target || target === '_self') ? 'Same Window' : target;

          // Validate Angular ngx-web-link wrapper pattern expectations
          const angularPattern = {
            angularClassification,
            hasNgxWrapper,
            hasSpecialAttrs,
            isRichText,
            linkText: text,
            href: absoluteUrl
          };
          const patternValidation = validateAngularLinkPattern(angularPattern);
          if (!patternValidation.isValid) {
            patternViolations.push({
              url: baseUrl,
              linkText: text,
              href: absoluteUrl,
              angularClassification,
              violations: patternValidation.violations,
              message: patternValidation.message
            });
            // Log pattern violations
            console.log(`   ${patternValidation.message}`);
          }

          logResult(
            stepDesc,
            expectedMsg,
            actualMsg,
            isSuccess ? 'PASS' : 'FAIL',
            (error ? error + anchorErrorMsg : anchorErrorMsg.substring(3)) || '',
            0, // retry count not tracked per link for simplicity
            baseUrl,
            absoluteUrl,
            linkType,
            statusCode ? statusCode.toString() : 'N/A',
            redirected,
            text,
            linkTarget,
            anchorIssue,
            link.elementType || 'HTML link',
            // Angular ngx-web-link pattern data
            angularClassification,
            hasNgxWrapper,
            hasSpecialAttrs,
            isRichText
          );
 
          // Small delay to avoid overwhelming the server
          await new Promise(resolve => setTimeout(resolve, 100));
        }
 
        // Summary for this URL
        const urlResults = results.filter(r => r.url === baseUrl);
        const urlPass = urlResults.filter(r => r.status === 'PASS').length;
        const urlFail = urlResults.filter(r => r.status === 'FAIL').length;
        const urlSkip = urlResults.filter(r => r.status === 'SKIP').length;
        const urlInfo = urlResults.filter(r => r.status === 'INFO').length;
        
        // Count Angular pattern classifications
        const angularValidCount = allLinks.filter(l => l.angularClassification === 'angular-valid').length;
        const angularExceptionCount = allLinks.filter(l => l.angularClassification === 'angular-exception').length;
        const richTextCount = allLinks.filter(l => l.angularClassification === 'rich-text-content').length;
        const angularTotalCount = angularValidCount + angularExceptionCount + richTextCount;
        
        // Individual detailed reports are disabled
        // Only consolidated combined report will be generated at the end
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let detailsReport = null;
        // Commented out to prevent individual URL-specific reports
        // if (urlFail > 0) {
        //   detailsReport = generateDetailedReport(urlResults, baseUrl, timestamp);
        // }
        
        // Store summary for dashboard
        urlSummaries.push({
          url: baseUrl,
          total: urlResults.length,
          passed: urlPass,
          failed: urlFail,
          skipped: urlSkip,
          info: urlInfo,
          detailsReport: detailsReport,
          angularValidCount: angularValidCount,
          angularExceptionCount: angularExceptionCount,
          richTextCount: richTextCount
        });

        // Log summary with Angular pattern statistics
        console.log(`   📊 URL Summary: ${urlPass} PASS, ${urlFail} FAIL, ${urlSkip} SKIP, ${urlInfo} INFO`);
        if (angularTotalCount > 0) {
          console.log(`   🅰️  Angular Patterns: ${angularValidCount} valid (ngx-web-link), ${angularExceptionCount} exceptions (special attrs), ${richTextCount} rich-text content`);
        }
 
      } catch (urlError) {
        logResult(
          `URL: ${baseUrl}`,
          'Validation completed',
          urlError.message,
          'FAIL',
          urlError.message,
          0,
          baseUrl,
          '',
          'N/A',
          'N/A',
          'No',
          'N/A',
          'N/A',
          'No'
        );
      } finally {
        if (context) {
          await context.close().catch(() => {});
        }
      }
      }  // Close the for (const baseUrl of batchUrls) loop

      } catch (batchError) {
        console.log(`⚠️ Batch ${batchNumber} error: ${batchError.message}`);
      }
      try {
        await browser.close();
      } catch (closeError) {
        console.log(`⚠️ Browser close warning: ${closeError.message}`);
      }

      // Pause between batches
      if (urlIndex < urls.length) {
        console.log(`\n⏸️  Batch ${batchNumber} complete. Pausing ${BATCH_PAUSE_MS}ms before next batch...\n`);
        await new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }  // Close the while loop
 
    // Final summary
    const totalTests = results.length;
    const passedTests = results.filter(r => r.status === 'PASS').length;
    const failedTests = results.filter(r => r.status === 'FAIL').length;
    const skippedTests = results.filter(r => r.status === 'SKIP').length;
    console.log(`\n📊 Final Summary: ${passedTests} PASS, ${failedTests} FAIL, ${skippedTests} SKIP (Total: ${totalTests})`);
 
  } catch (error) {
    logResult(
      'Script execution',
      'No fatal errors',
      error.message,
      'FAIL',
      error.message,
      0,
      '',
      '',
      'N/A',
      'N/A',
      'No',
      'N/A',
      'N/A',
      'No'
    );
  } finally {
    endTime = new Date();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Generate reports
    generateSummaryDashboard(urlSummaries, timestamp);
    generateCombinedReport(results, timestamp);
    const xlsxFilePath = await exportResults();

    // Post-process: open each failed "Navigated Link" URL in Playwright,
    // detect UI errors (mirroring error_validator.js logic), and write
    // results back to the "Status Fail" sheet as a "Page Errors" column.
    if (xlsxFilePath) {
      await runErrorValidationOnFailSheet(xlsxFilePath);
    }

    // Print Angular ngx-web-link pattern validation report
    if (patternViolations.length > 0) {
      console.log('\n');
      console.log('═══════════════════════════════════════════════════════════════════════');
      console.log('🚨 ANGULAR NGX-WEB-LINK PATTERN VALIDATION REPORT');
      console.log('═══════════════════════════════════════════════════════════════════════');
      console.log(`Total Pattern Violations Found: ${patternViolations.length}`);
      console.log('');
      
      // Group violations by type
      const byClassification = {};
      patternViolations.forEach(v => {
        if (!byClassification[v.angularClassification]) {
          byClassification[v.angularClassification] = [];
        }
        byClassification[v.angularClassification].push(v);
      });
      
      // Report each violation type
      Object.entries(byClassification).forEach(([classification, violations]) => {
        console.log(`\n📋 ${classification.toUpperCase()} (${violations.length} links):`);
        violations.forEach((v, idx) => {
          console.log(`   ${idx + 1}. ${v.linkText || '(unnamed)'}`);
          console.log(`      URL: ${v.url}`);
          console.log(`      Link: ${v.href}`);
          v.violations.forEach(violation => {
            console.log(`      ${violation}`);
          });
        });
      });
      
      console.log('\n═══════════════════════════════════════════════════════════════════════');
      console.log('📌 EXPECTED PATTERNS:');
      console.log('═══════════════════════════════════════════════════════════════════════');
      console.log('✅ angular-valid: MUST have ngx-web-link wrapper, NO special attributes');
      console.log('⚠️  angular-exception: MUST have ngx-web-link wrapper, WITH special attributes');
      console.log('📝 rich-text-content: MUST NOT have ngx-web-link wrapper (content-managed)');
      console.log('═══════════════════════════════════════════════════════════════════════\n');
    } else if (results.filter(r => r.angularClassification !== 'standard').length > 0) {
      // All Angular links follow expected patterns
      const angularLinks = results.filter(r => r.angularClassification !== 'standard');
      const validLinks = angularLinks.filter(r => {
        const pattern = { angularClassification: r.angularClassification, hasNgxWrapper: r.hasNgxWrapper, hasSpecialAttrs: r.hasSpecialAttrs, isRichText: r.isRichText };
        return validateAngularLinkPattern(pattern).isValid;
      });
      
      console.log('\n');
      console.log('═══════════════════════════════════════════════════════════════════════');
      console.log('✅ ANGULAR NGX-WEB-LINK PATTERN VALIDATION: ALL PASSED');
      console.log('═══════════════════════════════════════════════════════════════════════');
      console.log(`Total Angular pattern links: ${angularLinks.length}`);
      console.log(`Links following expected patterns: ${validLinks.length}`);
      const angularValid = angularLinks.filter(r => r.angularClassification === 'angular-valid').length;
      const angularException = angularLinks.filter(r => r.angularClassification === 'angular-exception').length;
      const richText = angularLinks.filter(r => r.angularClassification === 'rich-text-content').length;
      console.log(`  • Angular Valid (ngx-web-link, no attrs): ${angularValid}`);
      console.log(`  • Angular Exception (ngx-web-link, with attrs): ${angularException}`);
      console.log(`  • Rich Text Content (content-managed): ${richText}`);
      console.log('═══════════════════════════════════════════════════════════════════════\n');
    }

    // Small delay to ensure all async operations complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✅ Script finished.');
  }
})();