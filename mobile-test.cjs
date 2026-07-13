const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  // --- STEP 1: Load page ---
  console.log('STEP 1: Loading page at mobile viewport (390x844)...');
  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '/Users/eric/8765-mobile-initial.png', fullPage: false });
  console.log('  Screenshot: 8765-mobile-initial.png');

  // --- STEP 2: Verify viewport meta ---
  const hasViewport = await page.$eval('meta[name="viewport"]', el => !!el);
  console.log(`STEP 2: Viewport meta present: ${hasViewport}`);

  // --- STEP 3: Verify game scale ---
  const scaleInfo = await page.evaluate(() => {
    const game = document.getElementById('game');
    const style = getComputedStyle(game);
    const wrapper = document.getElementById('game-wrapper');
    const touchAction = style.touchAction;
    return {
      transform: style.transform,
      wrapperExists: !!wrapper,
      touchAction: touchAction,
      gameWidth: game.offsetWidth,
      gameHeight: game.offsetHeight,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    };
  });
  console.log('STEP 3: Scale info:', JSON.stringify(scaleInfo, null, 2));

  // --- STEP 4: Verify title screen visible ---
  const titleVisible = await page.$eval('#title-overlay', el =>
    !el.classList.contains('hidden')
  );
  console.log(`STEP 4: Title overlay visible: ${titleVisible}`);

  // --- STEP 5: Click start button ---
  console.log('STEP 5: Clicking "开始游戏"...');
  await page.click('#title-start');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/Users/eric/8765-mobile-after-start.png', fullPage: false });
  console.log('  Screenshot: 8765-mobile-after-start.png');

  // --- STEP 6: Verify game started ---
  const titleHidden = await page.$eval('#title-overlay', el =>
    el.classList.contains('hidden')
  );
  const dialogText = await page.$eval('#dialog-text', el => el.textContent);
  console.log(`STEP 6: Game started: ${titleHidden}, Dialog: "${dialogText?.substring(0, 30)}..."`);

  // --- STEP 7: Touch-to-skip typewriter ---
  console.log('STEP 7: Testing touch-to-skip (touchend on game area)...');
  const gameBox = await page.$('#game');
  const box = await gameBox.boundingBox();
  // Tap in the center of the game area (not on any button)
  await page.tap('#scene');
  await page.waitForTimeout(500);
  const dialogAfterTap = await page.$eval('#dialog-text', el => el.textContent?.length);
  console.log(`  Dialog text length after tap: ${dialogAfterTap}`);

  // --- STEP 8: Click a choice button ---
  const choices = await page.$$('.choice-btn');
  console.log(`STEP 8: Choice buttons found: ${choices.length}`);
  if (choices.length > 0) {
    // Wait for typewriter to finish and choices to appear
    await page.waitForSelector('.choice-btn', { timeout: 15000 });
    await page.click('.choice-btn:first-child');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/Users/eric/8765-mobile-after-choice.png', fullPage: false });
    console.log('  Screenshot: 8765-mobile-after-choice.png');
    const newDialog = await page.$eval('#dialog-text', el => el.textContent?.substring(0, 30));
    console.log(`  New dialog: "${newDialog}..."`);
  }

  // --- STEP 9: Check console errors ---
  console.log('STEP 9: Checking for JS errors...');
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  // Wait a bit for any errors
  await page.waitForTimeout(500);
  console.log(`  JS errors: ${errors.length === 0 ? 'NONE' : errors.join(', ')}`);

  // --- Final: Full flow screenshot ---
  await page.screenshot({ path: '/Users/eric/8765-mobile-final.png', fullPage: false });
  console.log('  Final screenshot: 8765-mobile-final.png');

  // --- STEP 10: Verify responsive scaling works ---
  const resizeTest = await page.evaluate(() => {
    const scale = window.innerWidth / 800;
    const clampedScale = Math.min(scale, 1);
    const game = document.getElementById('game');
    const cs = getComputedStyle(game);
    return {
      rawScale: scale,
      clampedScale: clampedScale,
      appliedTransform: cs.transform,
      scaleMatches: cs.transform.includes(clampedScale.toFixed(2).substring(0, 3)),
    };
  });
  console.log('STEP 10: Responsive scaling:', JSON.stringify(resizeTest, null, 2));

  // --- Rotate to landscape ---
  console.log('STEP 11: Testing landscape (844x390)...');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/Users/eric/8765-mobile-landscape.png', fullPage: false });
  console.log('  Screenshot: 8765-mobile-landscape.png');

  await browser.close();
  console.log('\n✅ ALL MOBILE TESTS COMPLETE');
})();
