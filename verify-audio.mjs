import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));

  try {
    // 1. Load the game
    console.log('1. Loading game...');
    await page.goto('http://localhost:8765/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#title-overlay');
    console.log('   ✅ Page loaded, title overlay visible');

    // 2. Verify title screen
    const titleText = await page.textContent('#title-game');
    console.log('   Title:', titleText);
    if (titleText !== '余烬酒馆') throw new Error('Title mismatch');

    // 3. Verify audio toggle exists
    const toggle = await page.$('#audio-toggle');
    if (!toggle) throw new Error('Audio toggle not found');
    console.log('   ✅ Audio toggle button found');

    // 4. Verify AudioEngine exists
    const hasAudio = await page.evaluate(() => typeof AudioEngine !== 'undefined');
    if (!hasAudio) throw new Error('AudioEngine not found on page');
    console.log('   ✅ AudioEngine module found');

    // 5. Start game
    console.log('2. Starting game...');
    await page.click('#title-start');
    await page.waitForTimeout(500);

    // Verify title is hidden
    const titleHidden = await page.evaluate(() => 
      document.querySelector('#title-overlay').classList.contains('hidden'));
    if (!titleHidden) throw new Error('Title overlay not hidden after start');
    console.log('   ✅ Game started, title hidden');

    // 6. Wait for typewriter and first dialogue
    console.log('3. Waiting for first dialogue...');
    await page.waitForTimeout(6000); // Wait for typewriter to finish

    // Check if choices appeared
    let choiceBtns = await page.$$('.choice-btn');
    if (choiceBtns.length === 0) {
      // Skip typewriter by clicking
      console.log('   Skipping typewriter...');
      await page.click('#game', { position: { x: 400, y: 400 } });
      await page.waitForTimeout(500);
      choiceBtns = await page.$$('.choice-btn');
    }
    console.log(`   ✅ ${choiceBtns.length} choices displayed`);

    // 7. Play through game: pick first choice repeatedly until ending
    console.log('4. Playing through game...');
    let rounds = 0;
    while (rounds < 15) {
      choiceBtns = await page.$$('.choice-btn');
      if (choiceBtns.length === 0) {
        // Check if ending overlay is visible
        const endVisible = await page.evaluate(() => 
          document.querySelector('#end-overlay').classList.contains('visible'));
        if (endVisible) {
          console.log('   ✅ Ending reached!');
          break;
        }
        // Wait for typewriter and check again
        await page.waitForTimeout(2000);
        choiceBtns = await page.$$('.choice-btn');
        if (choiceBtns.length === 0) {
          // Try skipping
          await page.click('#game', { position: { x: 400, y: 400 } });
          await page.waitForTimeout(500);
          choiceBtns = await page.$$('.choice-btn');
          if (choiceBtns.length === 0) {
            const endV = await page.evaluate(() => 
              document.querySelector('#end-overlay').classList.contains('visible'));
            if (endV) {
              console.log('   ✅ Ending reached!');
              break;
            }
            throw new Error('Stuck - no choices and no ending');
          }
        }
      }
      
      // Click first choice
      const btnText = await choiceBtns[0].textContent();
      console.log(`   Round ${rounds + 1}: Clicking "${btnText.trim().substring(0, 40)}..."`);
      await choiceBtns[0].click();
      await page.waitForTimeout(4000);
      rounds++;
    }

    // 8. Verify ending
    const endTitle = await page.textContent('#end-title');
    console.log(`   Ending title: "${endTitle}"`);
    if (!endTitle) throw new Error('No ending title shown');

    // 9. Check for JavaScript errors
    const errors = logs.filter(l => l.type === 'error' && !l.text.includes('favicon'));
    if (errors.length > 0) {
      console.log('   ⚠️ Console errors:', errors.map(e => e.text));
    } else {
      console.log('   ✅ No JavaScript errors');
    }

    // 10. Test audio toggle
    console.log('5. Testing audio toggle...');
    const initialMuted = await page.evaluate(() => AudioEngine.isMuted());
    console.log(`   Initial muted: ${initialMuted}`);
    await page.click('#audio-toggle');
    const nowMuted = await page.evaluate(() => AudioEngine.isMuted());
    console.log(`   After toggle muted: ${nowMuted}`);
    if (nowMuted === initialMuted) throw new Error('Audio toggle did not change state');

    console.log('\n🎉 ALL VERIFICATIONS PASSED!');
    console.log(`   Ending: "${endTitle}"`);
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
    console.error('Console logs:', logs.filter(l => l.type === 'error').map(e => e.text));
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
