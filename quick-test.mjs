import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    console.log('Loading page...');
    const resp = await page.goto('http://localhost:8765/index.html', { waitUntil: 'load', timeout: 15000 });
    console.log('Status:', resp.status());
    console.log('Title:', await page.title());
    console.log('Body has #title-overlay:', await page.$('#title-overlay') !== null);
    console.log('Body has #audio-toggle:', await page.$('#audio-toggle') !== null);
    console.log('AudioEngine exists:', await page.evaluate(() => typeof AudioEngine !== 'undefined'));
    
    // Check HTML structure
    const html = await page.content();
    console.log('HTML length:', html.length);
    console.log('Contains AudioEngine:', html.includes('AudioEngine'));
    console.log('Contains playDialogueAdvance:', html.includes('playDialogueAdvance'));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
})();
