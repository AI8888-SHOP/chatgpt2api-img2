// Run against a preview or production build. All application APIs are mocked:
// no real credentials, image generation, settings writes, or user data are used.
// PLAYWRIGHT_PATH=/path/to/playwright BASE_URL=http://127.0.0.1:3031 node tests/ui-regression.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:3031';
const out = process.env.UI_ARTIFACTS || '/tmp/chatgpt2api-ui-audit';
const audit = process.env.AUDIT_ONLY === '1';
const design = process.env.UI_DESIGN === 'b' ? 'b' : 'a';
const pixel = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#b8ded7"/><path d="M0 420L200 100L400 420M250 420L480 160L640 420" fill="#538d83"/></svg>');
const conversations = Array.from({ length: 40 }, (_, i) => ({
  id: `turn-${i}`, threadId: i < 2 ? 'thread-main' : `thread-${i}`,
  title: i < 2 ? '山间小屋' : `历史会话 ${i}`, prompt: `山间小屋，柔和的阳光，测试轮次 ${i}`,
  model: 'gpt-image-2', mode: 'generate', count: 1, status: 'success',
  createdAt: new Date(Date.UTC(2026, 8, 28, 12, 40 - i)).toISOString(),
  images: [{ id: `image-${i}`, status: 'success', url: pixel }],
}));
const report = [];
function check(name, ok, detail) {
  report.push({ name, ok: !!ok, detail });
  if (!audit) assert.ok(ok, `${name}: ${JSON.stringify(detail)}`);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 768, 1024, 1366, 1920]) {
      const heights = { 320: 568, 390: 844, 768: 1024, 1024: 768, 1366: 768, 1920: 1080 };
      const context = await browser.newContext({ viewport: { width, height: heights[width] } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      const writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const p = url.pathname;
        const api = p === '/app-config' || ['/v1/', '/api/', '/admin/api/'].some(prefix => p.startsWith(prefix));
        if (!api) {
          if (url.origin !== new URL(base).origin && !url.protocol.startsWith('data')) return route.abort();
          return route.continue();
        }
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        if (request.method() !== 'GET') writes.push(p);
        let body = {};
        if (p === '/app-config') body = { site_title: '绘图 UI 测试', quick_prompts: [], registration_enabled: true };
        else if (p === '/v1/user/ui-trial') body = { trial_id: 'studio-2026-09', assigned_variant: design, variant: design, preference: null, seen_a: true, seen_b: true };
        else if (p === '/v1/key/info') body = { remaining: 100, user: { username: 'UI 测试用户' } };
        else if (p === '/v1/image-conversations') body = request.method() === 'GET' ? { items: conversations } : { success: true };
        else if (p === '/v1/image-prompts/optimize') {
          await new Promise(resolve => setTimeout(resolve, 650));
          body = { optimized_prompt: '已经优化的提示词' };
        } else if (p === '/api/settings') {
          body = { config: JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.example.json'), 'utf8')) };
        } else if (p === '/api/cpa/pools') body = { pools: [] };
        else if (p === '/api/sub2api/servers') body = { servers: [] };
        else if (p.includes('jobs')) body = { items: [], status: 'error', job_id: 'mock-only', error: 'Test prevents real generation' };
        return route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } });
      });
      await page.goto(`${base}/image/`);
      const prompt = page.locator('textarea').first();
      await prompt.waitFor();
      await page.waitForTimeout(900);
      const layout = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid=image-results-scroll]');
        return { viewport: innerWidth, document: document.documentElement.scrollWidth, resultHeight: scroll?.clientHeight, pageScrollY: scrollY };
      });
      check(`layout-${width}`, layout.document <= width && layout.resultHeight >= 150, layout);
      await page.screenshot({ path: `${out}/image-${width}.png`, fullPage: true });
      const generate = page.getByRole('button', { name: /^(开始生成|生成)$/ });
      if (width >= 1280) {
        const initialAction = await generate.boundingBox();
        check(`desktop-action-in-first-viewport-${width}`, initialAction.y + initialAction.height <= heights[width], initialAction);
      }
      await generate.scrollIntoViewIfNeeded();
      const actionVisible = await generate.evaluate(el => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { reachable: hit === el || el.contains(hit), width: r.width, height: r.height };
      });
      check(`generate-reachable-${width}`, actionVisible.reachable, actionVisible);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (width === 390) {
        await page.getByRole('button', { name: '打开菜单', exact: true }).click();
        await page.keyboard.press('Escape');
        check('menu-escape', await page.getByRole('button', { name: '打开菜单', exact: true }).isVisible() && !(await page.getByRole('button', { name: '关闭菜单', exact: true }).count()));
        // Clean up the legacy drawer during baseline audits.
        if (await page.getByRole('button', { name: '关闭菜单', exact: true }).count()) await page.getByRole('button', { name: '关闭菜单', exact: true }).last().click();
        await page.getByRole('button', { name: '打开菜单', exact: true }).click();
        await page.getByRole('button', { name: '历史记录', exact: true }).click();
        await page.waitForTimeout(250);
        const historyOpened = await page.locator('aside:visible').count();
        check('history-opens-on-trailing-slash', historyOpened > 0);
        if (!historyOpened && audit) {
          await page.evaluate(() => window.dispatchEvent(new CustomEvent('image:open-history')));
          await page.waitForTimeout(150);
        }
        const history = await page.locator('aside:visible').evaluate(el => {
          const list = el.querySelector('.overflow-y-auto');
          return { bottom: el.getBoundingClientRect().bottom, viewport: innerHeight, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
        });
        check('history-scroll-bounds', history.bottom <= history.viewport && history.clientHeight > 100 && history.scrollHeight > history.clientHeight, history);
        await page.getByRole('button', { name: /山间小屋/ }).last().click();
        await page.getByRole('button', { name: '复用并继续对话', exact: true }).last().click();
        check('reuse-keeps-original-thread', await page.getByText('继续当前对话 · 已有 2 轮', { exact: true }).count() === 1 && (await prompt.inputValue()).includes('山间小屋'));
        await page.getByRole('button', { name: '查看结果图 1', exact: true }).last().click();
        await page.getByRole('dialog').click({ position: { x: 10, y: 120 } });
        check('lightbox-backdrop-close', !(await page.getByRole('dialog').count()));
        if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
        await prompt.fill('中文输入');
        const before = writes.length;
        await prompt.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
        await page.waitForTimeout(200);
        check('ime-no-submit', writes.length === before && await prompt.inputValue() === '中文输入', writes.slice(before));
        await prompt.fill('原始提示词');
        await page.getByRole('button', { name: /^优化$|AI.*优化提示词/ }).click();
        await prompt.fill('用户正在编辑的新提示词');
        await page.waitForTimeout(850);
        check('optimizer-preserves-edits', await prompt.inputValue() === '用户正在编辑的新提示词', await prompt.inputValue());
        await prompt.fill('这次正常优化');
        await page.getByRole('button', { name: /^优化$|AI.*优化提示词/ }).click();
        await page.waitForTimeout(850);
        check('optimizer-applies-result', await prompt.inputValue() === '已经优化的提示词', await prompt.inputValue());
        await page.getByRole('button', { name: '编辑图', exact: true }).click();
        const file = { name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
        await page.locator('input[type=file]').setInputFiles(file);
        await page.waitForTimeout(100);
        check('file-input-reset', await page.locator('input[type=file]').inputValue() === '');
        if (!audit) {
          const remove = page.getByRole('button', { name: '移除参考图 1', exact: true });
          check('mobile-remove-visible', Number(await remove.evaluate(el => getComputedStyle(el).opacity)) === 1);
          await remove.click();
          await page.locator('input[type=file]').setInputFiles(file);
          await page.getByRole('button', { name: '移除参考图 1', exact: true }).waitFor();
          await page.getByRole('combobox').filter({ hasText: 'PNG' }).click();
          await page.getByRole('option', { name: 'WEBP', exact: true }).click();
          // React can commit the selected label after the click promise resolves.
          await page.getByRole('combobox').filter({ hasText: 'webp' }).waitFor({ state: 'visible' });
          check('format-select-keeps-focus', await page.getByRole('combobox').filter({ hasText: 'webp' }).count() === 1);
        }
      }
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      if (width === 390) {
        const colors = await page.locator('.whitespace-pre-wrap').first().evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
        const channels = colors.background.match(/[\d.]+/g)?.map(Number) || [];
        const darkBackground = colors.background.startsWith('oklab(') ? channels[0] < 0.5 : colors.background.startsWith('rgb') && channels.slice(0, 3).every(value => value < 110);
        check('dark-prompt-background', darkBackground, colors);
      }
      await page.screenshot({ path: `${out}/image-dark-${width}.png`, fullPage: true });
      check(`runtime-errors-${width}`, errors.length === 0, errors);
      if ([320, 390, 768, 1366].includes(width)) {
        await page.goto(`${base}/admin/settings/`);
        await page.getByText('AI 提示词优化 · 独立 API', { exact: true }).waitFor();
        await page.waitForTimeout(600);
        const field = page.getByLabel('API Base URL（含 /v1）');
        await field.scrollIntoViewIfNeeded();
        const rect = await field.boundingBox();
        check(`settings-field-${width}`, rect && rect.x >= 0 && rect.x + rect.width <= width && rect.width >= 120, rect);
        await page.screenshot({ path: `${out}/settings-${width}.png` });
        check(`settings-errors-${width}`, errors.length === 0, errors);
      }
      if (width === 390) {
        for (const login of ['/login/', '/admin/login/']) {
          await page.goto(`${base}${login}`);
          await page.waitForTimeout(500);
          check(`login-no-workspace-nav-${login}`, await page.locator('header').count() === 0);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
