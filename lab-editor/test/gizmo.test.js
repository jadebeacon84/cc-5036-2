import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TransformGizmo } from '../src/editor/TransformGizmo.js';
import { createEquipment } from '../src/editor/equipment.js';
import { rayFromNDC } from '../src/editor/scene.js';
import { gizmoWorldSize } from '../src/editor/math3d.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const ray = (o, d) => ({ origin: o.clone(), direction: d.clone().normalize() });

function harness() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  camera.position.set(0, 4, 10);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);

  const parent = new THREE.Group();
  scene.add(parent);
  const obj = createEquipment('workbench');
  parent.add(obj);
  scene.updateMatrixWorld(true);

  const gizmo = new TransformGizmo(camera);
  gizmo.attach(obj);
  gizmo.update();
  return { scene, camera, parent, obj, gizmo };
}

function snapshot(obj) {
  return {
    p: obj.position.clone(),
    q: obj.quaternion.clone(),
    s: obj.scale.clone()
  };
}
function assertVecClose(actual, expected, eps = 1e-8, msg = '') {
  for (const k of ['x', 'y', 'z']) {
    assert.ok(
      Math.abs(actual[k] - expected[k]) <= eps,
      `${msg} ${k}: 实际 ${actual[k]} vs 期望 ${expected[k]}`
    );
  }
}
function assertSnapshotsEqual(a, b, eps = 1e-10) {
  assertVecClose(a.p, b.p, eps, '位置');
  assertVecClose(a.s, b.s, eps, '缩放');
  for (const k of ['x', 'y', 'z', 'w']) {
    assert.ok(Math.abs(a.q[k] - b.q[k]) <= eps, `四元数 ${k}`);
  }
}

test('平移：沿世界 X 轴拖动产生精确的单轴位移，其余分量不变', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('translate');
  const anchor = obj.getWorldPosition(new THREE.Vector3());

  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, ray(v3(0, 1, 8), v3(0, 0, -1)));
  // 射线目标点沿 X 移动 1.5m，起点保持
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(1.5, 0, -8)));

  const wp = obj.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(wp.x - (anchor.x + 1.5)) < 1e-8);
  assert.ok(Math.abs(wp.y - anchor.y) < 1e-8);
  assert.ok(Math.abs(wp.z - anchor.z) < 1e-8);
  gizmo.endDrag();
});

test('平移往返：向前再反向拖动同一意图，精确回到基准位（无浮点累积漂移）', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('translate');
  const base = snapshot(obj);

  const r0 = ray(v3(0, 1, 8), v3(0, 0, -1));
  const rFwd = ray(v3(0, 1, 8), v3(2, 0, -8));
  const rBack = ray(v3(0, 1, 8), v3(0, 0, -1));

  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, r0);
  gizmo.updateDrag(rFwd);
  gizmo.updateDrag(rFwd); // 重复事件不叠加
  gizmo.updateDrag(rBack);
  assertSnapshotsEqual(snapshot(obj), base);
  gizmo.endDrag();
});

test('退化：视线接近 X 轴时切换包含该轴的退化平面，结果有限且法向分量不动', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('translate');
  const anchor = obj.getWorldPosition(new THREE.Vector3());
  let statusMsg = '';
  gizmo.onStatus = (m) => { statusMsg = m; };

  // 视线几乎沿 +X（与操纵轴平行），从 X 负方向看过去
  const r0 = ray(v3(-8, 1, 0.0001), v3(1, 0, 0));
  const r1 = ray(v3(-8, 1, 1.0001), v3(1, 0, 0));
  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, r0);
  gizmo.updateDrag(r1);

  const wp = obj.getWorldPosition(new THREE.Vector3());
  assert.ok(wp.toArray().every(Number.isFinite), '退化时坐标必须全部有限');
  assert.ok(Math.abs(wp.y - anchor.y) < 1e-6, '退化平面法向为 Y，Y 分量必须不动');
  assert.match(statusMsg, /退化|平面/);
  gizmo.endDrag();
});

test('平面平移：Z 法向平面内拖动只改变 X/Y', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('translate');
  const anchor = obj.getWorldPosition(new THREE.Vector3());

  gizmo.beginDrag({ kind: 'plane', axis: 'z', mode: 'translate' }, ray(v3(0, 1, 8), v3(0, 0, -1)));
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(1.2, 2.4, -8)));

  const wp = obj.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(wp.x - (anchor.x + 1.2)) < 1e-7);
  assert.ok(Math.abs(wp.y - (anchor.y + 2.4)) < 1e-7);
  assert.ok(Math.abs(wp.z - anchor.z) < 1e-7, '平面法向分量必须为 0');
  gizmo.endDrag();
});

test('旋转：绕世界 Y 轴旋转 90°，世界姿态正确且往返还原', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('rotate');
  const base = snapshot(obj);
  const anchor = obj.getWorldPosition(new THREE.Vector3());

  // 旋转平面为 XZ（法向 Y）。先指向 +X，再转到 -Z（绕 +Y 的右手定则正方向）
  gizmo.beginDrag({ kind: 'ring', axis: 'y', mode: 'rotate' }, ray(v3(0, 5, 0), v3(1, -4, 0)));
  gizmo.updateDrag(ray(v3(0, 5, 0), v3(0, -4, -1)));

  const e = new THREE.Euler().setFromQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');
  assert.ok(Math.abs(e.y - Math.PI / 2) < 1e-7, `期望 90°，得到 ${e.y}`);

  // 拖回起始方向 -> 完全还原
  gizmo.updateDrag(ray(v3(0, 5, 0), v3(1, -4, 0)));
  assertSnapshotsEqual(snapshot(obj), base, 1e-9);
  assertVecClose(obj.getWorldPosition(new THREE.Vector3()), anchor, 1e-9);
  gizmo.endDrag();
});

test('旋转退化：环与视线平行时视图平面测角，结果有限', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('rotate');
  // 绕 Y 旋转，但视线沿 Y 方向（环被看成线）
  const r0 = ray(v3(0, 8, 0), v3(0, -1, 0));
  const r1 = ray(v3(0.3, 8, 0.3), v3(-0.3, -1, -0.3));
  gizmo.beginDrag({ kind: 'ring', axis: 'y', mode: 'rotate' }, r0);
  gizmo.updateDrag(r1);
  const q = obj.getWorldQuaternion(new THREE.Quaternion());
  assert.ok([q.x, q.y, q.z, q.w].every(Number.isFinite));
  gizmo.endDrag();
});

test('局部空间旋转：右乘到基准局部姿态', () => {
  const { gizmo, obj } = harness();
  gizmo.setSpace('local');
  gizmo.setMode('rotate');
  const baseQ = obj.quaternion.clone();

  gizmo.beginDrag({ kind: 'ring', axis: 'y', mode: 'rotate' }, ray(v3(0, 5, 0), v3(1, -4, 0)));
  gizmo.updateDrag(ray(v3(0, 5, 0), v3(0, -4, -1)));

  const expected = baseQ.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  );
  const d = obj.quaternion.angleTo(expected);
  assert.ok(d < 1e-7, `局部旋转应右乘，角差 ${d}`);
  gizmo.endDrag();
});

test('缩放：单轴非均匀缩放往返还原，并受最小值钳制', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('scale');
  gizmo.update();
  const base = snapshot(obj);
  const gSize = gizmo.group.scale.x;
  const anchor = obj.getWorldPosition(new THREE.Vector3());

  // 从 X 侧方横穿 Z 轴（与轴垂直的正常操作姿态）
  const r0 = ray(v3(6, anchor.y, 2), v3(-1, 0, 0));
  const r1 = ray(v3(6, anchor.y, 2 + gSize), v3(-1, 0, 0));
  gizmo.beginDrag({ kind: 'scaleAxis', axis: 'z', mode: 'scale' }, r0);
  gizmo.updateDrag(r1);
  assert.ok(Math.abs(obj.scale.z - 2) < 1e-6, `Z 应放大到 2，得到 ${obj.scale.z}`);
  assert.ok(Math.abs(obj.scale.x - 1) < 1e-9 && Math.abs(obj.scale.y - 1) < 1e-9, '非均匀：其余轴不变');

  gizmo.updateDrag(r0);
  assertSnapshotsEqual(snapshot(obj), base, 1e-9);

  // 极端向内拖 -> 钳制到 MIN_SCALE，不为负/零/NaN
  gizmo.updateDrag(ray(v3(6, anchor.y, 2 - 1e5), v3(-1, 0, 0)));
  assert.ok(obj.scale.z >= 0.02 - 1e-9);
  assert.ok(Number.isFinite(obj.scale.z));
  gizmo.endDrag();
});

test('缩放退化：视线与缩放轴近乎平行时退化平面仍能产生有限非负缩放', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('scale');
  gizmo.update();
  const r0 = ray(v3(-8, 1, 0), new THREE.Vector3(1, 0, 0)); // 沿 X 轴看 X 缩放轴
  const r1 = ray(v3(-8, 1, 2), new THREE.Vector3(1, 0, 0));
  gizmo.beginDrag({ kind: 'scaleAxis', axis: 'x', mode: 'scale' }, r0);
  gizmo.updateDrag(r1);
  assert.ok(obj.scale.toArray().every(Number.isFinite));
  assert.ok(obj.scale.x > 0);
  gizmo.endDrag();
});

test('等比缩放：三轴同比例，往返还原', () => {
  const { gizmo, obj } = harness();
  gizmo.setMode('scale');
  const base = snapshot(obj);
  const anchor = obj.getWorldPosition(new THREE.Vector3());

  // 在垂直于视线的平面内，把命中点从距锚点 2m 拉到 4m（等比 ×2）
  const r0 = ray(v3(2, anchor.y + 0, 8), v3(0, 0, -1));
  const r1 = ray(v3(4, anchor.y, 8), v3(0, 0, -1));
  gizmo.beginDrag({ kind: 'scaleCenter', mode: 'scale' }, r0);
  gizmo.updateDrag(r1);
  assert.ok(Math.abs(obj.scale.x - obj.scale.y) < 1e-9);
  assert.ok(Math.abs(obj.scale.y - obj.scale.z) < 1e-9);
  assert.ok(obj.scale.x > 1.9 && obj.scale.x < 2.1, `期望约 2，得到 ${obj.scale.x}`);

  gizmo.updateDrag(r0);
  assertSnapshotsEqual(snapshot(obj), base, 1e-9);
  assertVecClose(obj.getWorldPosition(new THREE.Vector3()), anchor, 1e-9);
  gizmo.endDrag();
});

test('旋转父节点 + 非均匀父缩放：世界坐标移动正确映射回局部', () => {
  const { gizmo, parent, obj } = harness();
  parent.rotation.y = Math.PI / 4;
  parent.scale.set(2, 0.5, 1.5);
  parent.updateMatrixWorld(true);
  obj.updateWorldMatrix(true, false);
  gizmo.setMode('translate');

  const anchor = obj.getWorldPosition(new THREE.Vector3());
  gizmo.update();
  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, ray(v3(0, 1, 8), v3(0, 0, -1)));
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(2, 0, -8)));

  const wp = obj.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(wp.x - (anchor.x + 2)) < 1e-7);
  assert.ok(Math.abs(wp.y - anchor.y) < 1e-7);
  assert.ok(Math.abs(wp.z - anchor.z) < 1e-7);

  // 父节点逆变换后局部坐标必须有限
  assert.ok(obj.position.toArray().every(Number.isFinite));
  gizmo.endDrag();
});

test('世界旋转在旋转父节点下：子节点世界姿态等于左乘结果', () => {
  const { gizmo, parent, obj } = harness();
  parent.rotation.y = 0.6;
  parent.updateMatrixWorld(true);
  gizmo.setMode('rotate');
  gizmo.update();
  const baseWorldQ = obj.getWorldQuaternion(new THREE.Quaternion());

  gizmo.beginDrag({ kind: 'ring', axis: 'y', mode: 'rotate' }, ray(v3(0, 5, 0), v3(1, -4, 0)));
  gizmo.updateDrag(ray(v3(0, 5, 0), v3(0, -4, -1)));

  const expected = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    .multiply(baseWorldQ);
  const actual = obj.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(actual.angleTo(expected) < 1e-7);
  gizmo.endDrag();
});

test('正交投影：平移与屏幕恒定尺度均正常', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 100);
  camera.position.set(0, 4, 10);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);

  const obj = createEquipment('cabinet');
  scene.add(obj);
  scene.updateMatrixWorld(true);

  const gizmo = new TransformGizmo(camera);
  gizmo.attach(obj);
  gizmo.setMode('translate');
  gizmo.update();

  const size1 = gizmo.group.scale.x;
  camera.position.set(0, 4, 30); // 正交相机拉远不应改变操纵器世界尺度
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  gizmo.update();
  assert.ok(Math.abs(gizmo.group.scale.x - size1) < 1e-9);

  const anchor = obj.getWorldPosition(new THREE.Vector3());
  // 正交射线方向恒定
  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, ray(v3(0, 1, 8), v3(0, 0, -1)));
  gizmo.updateDrag(ray(v3(1.25, 1, 8), v3(0, 0, -1)));
  const wp = obj.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(wp.x - (anchor.x + 1.25)) < 1e-7);
  gizmo.endDrag();
});

test('操纵器尺度与对象几何尺度解耦：极大/极小模型手感一致', () => {
  const { gizmo, obj } = harness();
  gizmo.update();
  const normalSize = gizmo.group.scale.x;

  obj.scale.setScalar(1000);
  gizmo.update();
  const hugeSize = gizmo.group.scale.x;

  obj.scale.setScalar(0.001);
  gizmo.update();
  const tinySize = gizmo.group.scale.x;

  assert.ok(Math.abs(hugeSize - normalSize) < 1e-9);
  assert.ok(Math.abs(tinySize - normalSize) < 1e-9);
});

test('画布边缘射线：四角 NDC 生成的射线全部单位化且有限，求交不退化崩溃', () => {
  const { camera, gizmo, obj } = harness();
  for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [1, 0], [-1, 0]]) {
    const r = rayFromNDC(camera, nx, ny);
    assert.ok(Math.abs(r.direction.length() - 1) < 1e-9);
    assert.ok(r.origin.toArray().every(Number.isFinite));
    gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, r);
    gizmo.updateDrag(r);
    assert.ok(obj.position.toArray().every(Number.isFinite));
    gizmo.endDrag();
  }
});

test('拾取：只命中当前模式的手柄', () => {
  const { gizmo } = harness();
  gizmo.setMode('translate');
  const translateHit = gizmo.pick(ray(v3(-1, 1, 8), v3(1, 0, -8)));
  assert.ok(translateHit === null || translateHit.mode === 'translate');

  gizmo.setMode('rotate');
  // 穿过旋转环半径 0.72 附近的射线
  const rotateHit = gizmo.pick(ray(v3(0.72, 1, 8), v3(0, 0, -1)));
  assert.ok(rotateHit !== null && rotateHit.mode === 'rotate');
  assert.equal(rotateHit.kind, 'ring');
});

test('gizmoWorldSize 与 Gizmo 内部尺度公式一致（透视）', () => {
  const { camera, gizmo, obj } = harness();
  const dist = camera.position.distanceTo(obj.getWorldPosition(new THREE.Vector3()));
  const expected = gizmoWorldSize({ projection: 'perspective', distance: dist, fovY: camera.fov });
  gizmo.update();
  assert.ok(Math.abs(gizmo.group.scale.x - expected) < 1e-9);
});
