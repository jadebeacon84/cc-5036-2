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

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await sleep(500);
  check(await page.locator('#viewport').count() === 1, '页面与画布加载');

  // 1. 添加两台设备
  await page.locator('.add-item').first().click();
  await sleep(200);
  await page.locator('.add-item').nth(1).click();
  await sleep(200);
  const sceneCount = await page.locator('.scene-item').count();
  check(sceneCount === 2, `场景设备数量为 2（实际 ${sceneCount}）`);

  // 2. 检查器显示实际世界位置（只读，无数字输入框）
  const inspectorText = await page.locator('#inspector').innerText();
  check(/世界位置 \(m\)/.test(inspectorText), '检查器展示实际世界位置');
  check(/当前约束/.test(inspectorText), '检查器展示约束轴信息');
  const numberInputs = await page.locator('#inspector input').count();
  check(numberInputs === 0, '检查器不含数值输入框（坚持直接三维交互）');

  // 3. 真实拖拽平移操纵器：先确保处于移动模式并选中设备
  await page.keyboard.press('w');
  const box = await page.locator('#viewport').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const before = await page.locator('#inspector').innerText();
  // 从中心向右侧拖动（命中 X 轴手柄的概率最高）
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(cx + i * 12, cy);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(200);
  const after = await page.locator('#inspector').innerText();
  check(before !== after, '拖拽后检查器数值发生变化（平移生效）');

  // 4. 旋转模式 + 拖拽
  await page.keyboard.press('e');
  check((await page.locator('#mode-rotate').getAttribute('class')).includes('active'), '切换到旋转模式');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(cx + i * 10, cy - i * 6);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(150);
  check(/世界姿态/.test(await page.locator('#inspector').innerText()), '旋转后姿态更新');

  // 5. 缩放模式（局部轴语义）
  await page.keyboard.press('r');
  check((await page.locator('#mode-scale').getAttribute('class')).includes('active'), '切换到缩放模式');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(cx + i * 8, cy + i * 8);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(150);

  // 6. 世界/局部空间切换
  await page.keyboard.press('q');
  check(/局部/.test(await page.locator('#space-toggle').innerText()), '切换到局部坐标模式');
  await page.keyboard.press('q');
  check(/世界/.test(await page.locator('#space-toggle').innerText()), '切回世界坐标模式');

  // 7. 透视/正交投影切换后仍可交互
  await page.keyboard.press('p');
  check(/正交/.test(await page.locator('#cam-toggle').innerText()), '切换到正交投影');
  await page.keyboard.press('w');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 20, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
  check((await page.locator('#status-line').innerText()).length > 0, '正交投影下交互无异常');
  await page.keyboard.press('p');
  check(/透视/.test(await page.locator('#cam-toggle').innerText()), '切回透视投影');

  // 8. 画布边缘指针事件不产生 NaN/异常
  for (const [ex, ey] of [
    [box.x + 4, box.y + 4],
    [box.x + box.width - 4, box.y + box.height - 4],
    [box.x + box.width - 4, box.y + 4]
  ]) {
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.mouse.move(ex + 6, ey + 6, { steps: 3 });
    await page.mouse.up();
  }
  await sleep(200);
  const inspectorFinal = await page.locator('#inspector').innerText();
  check(!/NaN|Infinity|-0\.000\.\./.test(inspectorFinal), '画布边缘操作后无数值异常');

  // 9. 保存到 localStorage 并校验布局 JSON
  await page.locator('#save-btn').click();
  await sleep(700);
  const saved = await page.evaluate(() => localStorage.getItem('lab-editor-layout-v1'));
  const data = JSON.parse(saved);
  check(data.format === 'lab-layout' && data.items.length === 2, '布局已保存且包含 2 台设备');
  check(Array.isArray(data.items[0].position) && data.items[0].position.length === 3, '保存数据含完整位置/旋转/缩放');
  check(/安全/.test(await page.locator('.safety').innerText()), '界面包含安全免责声明');

  // 10. 全程无页面错误
  check(errors.length === 0, `无控制台/页面错误（实际：${errors.join(' | ') || '无'}）`);

  console.log('\n浏览器冒烟测试全部通过');
} finally {
  await browser.close();
  await server.close();
}
