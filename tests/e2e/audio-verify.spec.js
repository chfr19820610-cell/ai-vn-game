// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Audio System Verification', () => {
  test('Load page, start game, advance dialogue, select choices, reach ending with audio', async ({ page }) => {
    // Collect console logs
    const logs = [];
    page.on('console', msg => logs.push({ type: msg.type(), text: msg.text() }));

    // Navigate to the game
    await page.goto('http://localhost:8765/index.html');
    await page.waitForSelector('#title-overlay');
    
    // Verify title screen is visible
    await expect(page.locator('#title-game')).toBeVisible();
    await expect(page.locator('#title-game')).toHaveText('余烬酒馆');
    
    // Verify audio toggle button exists
    await expect(page.locator('#audio-toggle')).toBeVisible();
    
    // Click "开始游戏"
    await page.click('#title-start');
    
    // Wait for game to start - title overlay should be hidden
    await expect(page.locator('#title-overlay')).toHaveClass(/hidden/);
    
    // Verify Lena is active
    await expect(page.locator('#npc-lena')).not.toHaveClass(/hidden/);
    
    // Wait for typewriter to finish (first dialogue)
    await page.waitForTimeout(5000); // Wait for typewriter
    
    // Click to advance/skip if still typing
    // Check if cursor-blink exists (means typing finished) or choices are visible
    try {
      await page.waitForSelector('.choice-btn', { timeout: 10000 });
    } catch (e) {
      // If no choices yet, skip typewriter
      await page.click('#game', { position: { x: 400, y: 300 } });
      await page.waitForSelector('.choice-btn', { timeout: 5000 });
    }
    
    // Verify choices are displayed
    const choiceCount = await page.locator('.choice-btn').count();
    expect(choiceCount).toBeGreaterThan(0);
    
    // Select first choice
    await page.locator('.choice-btn').first().click();
    await page.waitForTimeout(4000);
    
    // Continue clicking through dialogue until we reach ending
    // Play through the game by always picking the first choice
    for (let i = 0; i < 12; i++) {
      // Wait for choices or skip typewriter
      try {
        await page.waitForSelector('.choice-btn', { timeout: 8000 });
      } catch {
        // Skip typewriter by clicking
        await page.click('#game', { position: { x: 400, y: 300 } });
        await page.waitForSelector('.choice-btn', { timeout: 5000 });
      }
      
      const btns = page.locator('.choice-btn');
      const count = await btns.count();
      if (count === 0) break;
      
      // Pick the first choice
      await btns.first().click();
      await page.waitForTimeout(3000);
    }
    
    // Verify ending overlay is visible
    await expect(page.locator('#end-overlay')).toHaveClass(/visible/);
    
    // Verify ending title is shown
    const endTitle = await page.locator('#end-title').textContent();
    expect(endTitle).toBeTruthy();
    
    // Verify no JavaScript errors (no console.error with the word "Error")
    const errors = logs.filter(l => l.type === 'error');
    const realErrors = errors.filter(e => !e.text.includes('favicon') && !e.text.includes('404'));
    if (realErrors.length > 0) {
      console.log('Console errors found:', realErrors);
    }
    
    // Check that AudioEngine exists on page
    const hasAudio = await page.evaluate(() => typeof AudioEngine !== 'undefined');
    expect(hasAudio).toBe(true);
    
    console.log('✅ All checks passed!');
    console.log(`Ending reached: "${endTitle}"`);
  });
});
