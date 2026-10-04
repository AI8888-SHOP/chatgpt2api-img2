// All API responses are synthetic; no production credentials or paid calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3031';
const out = process.env.UI_ARTIFACTS || '/tmp/usage-upstream-ui';

(async () => {
  const browser = await chromium.launch({args: ['--no-sandbox']});
  fs.mkdirSync(out, {recursive: true});
  const labels = ['主线路', '备用线路', 'ChatGPT 账号池', '未调用上游', '未记录', '<script>window.injected=true</script>' + 'VeryLongProviderName'.repeat(6)];
  const records = labels.map((label, i) => ({id: String(i), timestamp: 1791129600, action: 'image_generate',
    status: i % 2 ? 'failed' : 'success', model: 'gpt-image-2', prompt: '模拟需求 ' + i,
    api_key: 'synthetic***', api_key_name: '测试用户', duration_ms: 1234,
    ...(i === 4 ? {} : {upstream_name: label})}));
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({viewport: {width, height: 1000}});
      await context.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (!['/admin/api/', '/api/', '/v1/', '/auth/', '/app-config'].some(prefix => p.startsWith(prefix))) {
          return url.origin === new URL(base).origin || url.protocol === 'data:' ? route.continue() : route.abort();
        }
        let body = {};
        if (p.endsWith('/usage/records')) body = {records, total: records.length};
        else if (p.endsWith('/usage/stats')) body = {total: 6, success: 3, failed: 3, avg_duration_ms: 1234, daily_stats: {}, action_stats: {}};
        else if (p.endsWith('/users')) body = {users: [], total: 0};
        else if (p.includes('generated-images')) body = {images: [], total: 0, total_size_bytes: 0};
        return route.fulfill({json: body});
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      for (const path of ['/admin/usage/', '/admin/']) {
        await page.goto(base + path);
        await page.getByRole('columnheader', {name: '上游', exact: true}).waitFor();
        const rows = page.locator('tbody tr');
        assert.equal(await rows.count(), records.length);
        for (let i = 0; i < labels.length; i++) assert.ok((await rows.nth(i).innerText()).includes(labels[i]));
        assert.equal(await page.evaluate(() => !!window.injected), false);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page-level overflow');
        if (path === '/admin/') assert.match(await page.getByRole('link', {name: '查看用量', exact: true}).getAttribute('href'), /^\/admin\/usage\/?$/);
        await page.screenshot({path: `${out}/${path.includes('usage') ? 'usage' : 'dashboard'}-${width}.png`, fullPage: true});
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Usage upstream browser checks passed: desktop/mobile, both tables, legacy, long names, safe text, link.');
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exit(1);});
