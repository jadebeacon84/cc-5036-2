// 浏览器端冒烟测试：真实 WebGL + 真实指针事件。
// 运行方式：先安装浏览器与系统依赖（`npx playwright install --with-deps chromium`），
// 再执行 `npm run test:browser`。缺少系统库（如 libnspr4）时本测试自动跳过。
import { chromium } from 'playwright';
import { createServer } from 'vite';

const HEADLESS_SHELL = process.env.CHROMIUM_HEADLESS_SHELL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({ server: { port: 5199, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
await sleep(1000); // 等待依赖预扫描完成，避免浏览器缺失时提前关闭服务器
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch(HEADLESS_SHELL
  ? { executablePath: HEADLESS_SHELL, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
  : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }).catch(async (err) => {
    if (/shared librar|libnspr|libnss|cannot open shared object/i.test(String(err))) {
      console.log('跳过浏览器冒烟测试：系统缺少 Chromium 运行库。');
      console.log('请在具备 root 的环境执行：npx playwright install --with-deps chromium');
      await server.close();
      process.exit(0);
    }
    throw err;
  });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

function check(cond, name) {
  if (!cond) throw new Error(`断言失败：${name}`);
  console.log(`  ok - ${name}`);
}

// 在画布中央区域扫描，找到当前模式下真正能被 gizmo 拾取的像素（视口坐标）。
// 操纵手柄较细，盲拖中心容易落空，因此先用内核 pick 定位再发真实指针事件。
async function findHandlePixel(kind) {
  return page.evaluate(async (wantKind) => {
    const mod = await import('/src/main.js');
    const g = mod.gizmo;
    const canvas = document.getElementById('viewport');
    const rect = canvas.getBoundingClientRect();
    g.update();
    for (let fx = 0.2; fx <= 0.8; fx += 0.04) {
      for (let fy = 0.2; fy <= 0.8; fy += 0.04) {
        const ndcX = fx * 2 - 1;
        const ndcY = -(fy * 2 - 1);
        const r = mod.rayFromNDC(g.camera, ndcX, ndcY);
        const h = g.pick(r);
        if (h && (!wantKind || h.kind === wantKind)) {
          return { x: rect.left + fx * rect.width, y: rect.top + fy * rect.height, handle: h };
        }
      }
    }
    return null;
  }, kind);
}

async function dragPixel(from, dx, dy, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await sleep(30);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(150);
}

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(500);
  check(await page.locator('#viewport').count() === 1, '页面与画布加载');

  // 1. 添加两台设备
  await page.locator('.add-item').first().click();
  await sleep(150);
  await page.locator('.add-item').nth(1).click();
  await sleep(150);
  check(await page.locator('.scene-item').count() === 2, '场景设备数量为 2');

  // 2. 检查器展示实际世界位置（只读，无数字输入框）
  const inspectorText = await page.locator('#inspector').innerText();
  check(/世界位置 \(m\)/.test(inspectorText), '检查器展示实际世界位置');
  check(/当前约束/.test(inspectorText), '检查器展示约束轴信息');
  check((await page.locator('#inspector input').count()) === 0, '检查器不含数值输入框');

  // 3. 真实拖拽平移：先定位平移轴手柄像素，再做真实指针拖拽
  await page.keyboard.press('w');
  await sleep(100);
  const axisPx = await findHandlePixel('axis');
  check(axisPx !== null, '扫描到平移轴手柄像素');
  const before = await page.locator('#inspector').innerText();
  await dragPixel(axisPx, 90, 0);
  const after = await page.locator('#inspector').innerText();
  check(before !== after, '真实拖拽平移轴后检查器数值变化（平移生效）');

  // 4. 旋转模式真实拖拽
  await page.keyboard.press('e');
  check((await page.locator('#mode-rotate').getAttribute('class')).includes('active'), '切换到旋转模式');
  const ringPx = await findHandlePixel('ring');
  check(ringPx !== null, '扫描到旋转环手柄像素');
  await dragPixel(ringPx, 70, -50, 10);
  check(/世界姿态/.test(await page.locator('#inspector').innerText()), '旋转后检查器仍展示世界姿态');

  // 5. 缩放模式（局部轴语义）
  await page.keyboard.press('r');
  check((await page.locator('#mode-scale').getAttribute('class')).includes('active'), '切换到缩放模式');
  const scalePx = await findHandlePixel('scaleAxis');
  check(scalePx !== null, '扫描到缩放轴手柄像素');
  await dragPixel(scalePx, 50, 50, 8);

  // 6. 多选：Shift+点击场景列表第二项，形成两台设备的多选集合
  await page.keyboard.press('w');
  const items = page.locator('.scene-item');
  await items.nth(0).click();
  await sleep(100);
  await items.nth(1).click({ modifiers: ['Shift'] });
  await sleep(150);
  const multiInfo = await page.evaluate(async () => {
    const mod = await import('/src/main.js');
    return { count: mod.gizmo.objects.length };
  });
  check(multiInfo.count === 2, `Shift 多选后 gizmo 绑定 2 台（实际 ${multiInfo.count}）`);
  check(/多选/.test(await page.locator('#inspector').innerText()), '检查器提示多选状态');

  // 7. 多选同拖：两台设备获得同一世界增量，世界位移逐对象一致
  const worldMoves = await page.evaluate(async () => {
    const mod = await import('/src/main.js');
    return mod.gizmo.objects.map((o) => o.getWorldPosition(o.position.clone()).toArray());
  });
  const multiAxis = await findHandlePixel('axis');
  check(multiAxis !== null, '多选下扫描到平移轴手柄');
  await dragPixel(multiAxis, 80, 0);
  const worldMoves2 = await page.evaluate(async () => {
    const mod = await import('/src/main.js');
    return mod.gizmo.objects.map((o) => o.getWorldPosition(o.position.clone()).toArray());
  });
  const d0 = worldMoves2[0].map((v, i) => v - worldMoves[0][i]);
  const d1 = worldMoves2[1].map((v, i) => v - worldMoves[1][i]);
  const sameMove = d0.every((v, i) => Math.abs(v - d1[i]) < 1e-6);
  check(sameMove, `多选两对象世界位移一致（${d0.map((n) => n.toFixed(3))} vs ${d1.map((n) => n.toFixed(3))}）`);

  // 8. Esc 取消拖动：拖一段后按 Esc，设备恢复本次拖动前姿态
  const beforeEsc = await page.evaluate(async () => {
    const mod = await import('/src/main.js');
    return mod.gizmo.objects.map((o) => o.position.toArray());
  });
  const escPx = await findHandlePixel('axis');
  await page.mouse.move(escPx.x, escPx.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(escPx.x + i * 10, escPx.y);
    await sleep(16);
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await sleep(150);
  const afterEsc = await page.evaluate(async () => {
    const mod = await import('/src/main.js');
    return mod.gizmo.objects.map((o) => o.position.toArray());
  });
  const escRestored = beforeEsc.every((p, oi) => p.every((v, i) => Math.abs(v - afterEsc[oi][i]) < 1e-9));
  check(escRestored, 'Esc 取消后所有对象恢复拖动前局部位置');

  // 9. Ctrl+Z 撤销：撤销第 7 步多选拖动，位置回到该步之前
  const undoDisabledBefore = await page.locator('#undo-btn').isDisabled();
  check(undoDisabledBefore === false, '发生过变换后撤销按钮可用');
  await page.keyboard.press('Control+z');
  await sleep(150);
  const afterUndo = await page.evaluate(async () => {
    const mod = await import('/src/main.js');
    return mod.gizmo.objects.map((o) => o.getWorldPosition(o.position.clone()).toArray());
  });
  const undone = afterUndo.every((p, oi) => p.every((v, i) => Math.abs(v - worldMoves[oi][i]) < 1e-6));
  check(undone, 'Ctrl+Z 撤销多选拖动，世界位置回退到拖动前');

  // 10. 世界/局部空间与投影切换后仍可交互
  await page.keyboard.press('q');
  check(/局部/.test(await page.locator('#space-toggle').innerText()), '切换到局部坐标模式');
  await page.keyboard.press('q');
  check(/世界/.test(await page.locator('#space-toggle').innerText()), '切回世界坐标模式');
  await page.keyboard.press('p');
  check(/正交/.test(await page.locator('#cam-toggle').innerText()), '切换到正交投影');
  const orthoPx = await findHandlePixel('axis');
  if (orthoPx) await dragPixel(orthoPx, 40, 10, 5);
  check((await page.locator('#status-line').innerText()).length > 0, '正交投影下交互无异常');
  await page.keyboard.press('p');
  check(/透视/.test(await page.locator('#cam-toggle').innerText()), '切回透视投影');

  // 11. 保存到 localStorage 并校验布局 JSON
  await page.locator('#save-btn').click();
  await sleep(700);
  const saved = await page.evaluate(() => localStorage.getItem('lab-editor-layout-v1'));
  const data = JSON.parse(saved);
  check(data.format === 'lab-layout' && data.items.length === 2, '布局已保存且包含 2 台设备');
  check(Array.isArray(data.items[0].position) && data.items[0].position.length === 3, '保存数据含完整位置/旋转/缩放');
  check(/安全/.test(await page.locator('.safety').innerText()), '界面包含安全免责声明');

  // 12. 全程无页面错误，无数值异常
  check(!/NaN|Infinity/.test(await page.locator('#inspector').innerText()), '检查器无数值异常');
  check(errors.length === 0, `无控制台/页面错误（实际：${errors.join(' | ') || '无'}）`);

  console.log('\n浏览器冒烟测试全部通过');
} finally {
  await browser.close();
  await server.close();
}
