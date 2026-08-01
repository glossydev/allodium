import { chromium } from 'playwright';
const OUT = process.argv[2];
const B = 'http://localhost:3180';
const browser = await chromium.launch();
const T = 60000;
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

const shot = async (name, note) => {
  await page.screenshot({ path: `${OUT}/shot-${name}.png` });
  console.log('  captured', name, note ? '— ' + note : '');
};
const dlg = () => page.locator('[role=dialog]');

// 1 — Schema, table selected
await page.goto(`${B}/schema`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: T });
await page.locator('table tbody tr', { hasText: /^orders/ }).first().click();
await page.waitForTimeout(900);
await shot('schema');

// 2 — the FK builder, mid-flow
await page.getByRole('button', { name: '+ Foreign key' }).click();
await dlg().waitFor({ state: 'visible' });
await page.waitForTimeout(400);
const colSel = dlg().locator('select').first();
await colSel.selectOption('customer_id').catch(async () => {
  const opts = await colSel.locator('option').allInnerTexts();
  console.log('    (fk column options:', opts.join(' | '), ')');
});
await page.waitForTimeout(1200);
await shot('fk-builder', 'flagship flow');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 3 — Types surface
await page.getByRole('button', { name: 'Types', exact: true }).click();
await page.waitForTimeout(800);
await shot('types');

// 4 — Content with the FK peek open
await page.goto(`${B}/content?table=products`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-allodium], table tbody tr', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1200);
const headers = await page.$$eval('table thead th', (t) => t.map((x) => x.textContent.trim().replace(/[▲▼]|pk/g, '').trim()));
const ci = headers.indexOf('category_id');
const rows = page.locator('table tbody tr');
for (let i = 0; i < (await rows.count()); i++) {
  const b = rows.nth(i).locator('td').nth(ci).locator('button');
  if (await b.count()) { await b.first().hover(); break; }
}
await page.waitForTimeout(1400);
await shot('content-peek', 'FK hover peek');

// 5 — Content row drawer with relation picker
await page.locator('table tbody tr').nth(1).click();
await page.waitForTimeout(1200);
await shot('content-drawer');
await page.keyboard.press('Escape');

// 6 — Users, role-filtered
await page.goto(`${B}/users`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: T });
await page.waitForTimeout(800);
await shot('users');

// 7 — Roles matrix
await page.goto(`${B}/roles`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Roles by rank', { timeout: T });
await page.waitForTimeout(900);
await shot('roles-superadmin', 'super_admin bypasses the model');
await page.getByRole('button', { name: /Customer Service/ }).first().click();
await page.waitForSelector('table tbody tr', { timeout: T });
await page.waitForTimeout(900);
await shot('roles');

// 8 — Files
await page.goto(`${B}/files`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('table tbody tr', { timeout: T });
await page.waitForTimeout(800);
await shot('files');

// 9 — SQL with a result
await page.goto(`${B}/sql`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await page.locator('textarea').fill("select status, count(*) as orders, round(sum(total),2) as revenue\nfrom orders group by status order by 2 desc");
await page.getByRole('button', { name: 'Run' }).click();
await page.waitForTimeout(1600);
await shot('sql');

// 10 — SQL refusing a write (the safety story, visible)
await page.locator('textarea').fill('delete from orders');
await page.getByRole('button', { name: 'Run' }).click();
await page.waitForTimeout(1400);
await shot('sql-readonly', 'write refused');

// 11 — Admin Builder (slow: cold route + 4 sequential fetches)
await page.goto(`${B}/admin-builder`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-field-row]', { timeout: T });
await page.waitForSelector('[data-allodium="table"]', { timeout: T }).catch(() => {});
await page.waitForTimeout(1200);
await shot('admin-builder');

console.log('\nconsole errors during capture:', problems.length ? problems : 'none');
await browser.close();
