// 多父节点多选操纵回归：
//  1. 多个对象挂在不同父节点（各自带旋转 + 非均匀缩放）下，同一世界增量必须
//     分别经“各自父节点世界逆矩阵”映射回局部，不能共用一个父变换，更不能清空父变换；
//  2. 取消拖动（pointercancel / Esc）必须把每个对象恢复到拖动前的局部原值；
//  3. 提交后由内核快照/恢复接口驱动上层撤销；
//  4. 边界：局部位置非零、极端非均匀父缩放、往返拖动等多选场景。
//
// 期望值不写死射线原点平移量：轴/平面求交的世界意图本身由 math3d 决定，
// 这里让每个对象“单独拖一次”得到参考世界位移，再要求多选结果逐对象一致，
// 从而把“世界意图计算”与“多父局部换算”两个关注点彻底分开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TransformGizmo } from '../src/editor/TransformGizmo.js';
import { createEquipment } from '../src/editor/equipment.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const ray = (o, d) => ({ origin: o.clone(), direction: d.clone().normalize() });
const R0 = () => ray(v3(0, 1, 8), v3(0, 0, -1));

function makeCamera() {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  camera.position.set(0, 4, 10);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

// 独立搭一个只含单个对象的场景，单独拖一次，返回它产生的世界位移与局部坐标。
// 多选的语义是：以主对象为锚点把世界意图计算一次，再把“同一个世界向量”
// 施加给所有对象（各走各的父逆矩阵）。因此参考只取主对象那一次拖拽。
function referenceWorldMove({ parentTransform, localPos, handle, moveRay, mode, space }) {
  const scene = new THREE.Scene();
  const camera = makeCamera();
  const parent = new THREE.Group();
  if (parentTransform.rotation) parent.rotation.set(...parentTransform.rotation);
  if (parentTransform.scale) parent.scale.set(...parentTransform.scale);
  scene.add(parent);
  const obj = createEquipment('workbench');
  obj.position.set(...localPos);
  parent.add(obj);
  scene.updateMatrixWorld(true);

  const gizmo = new TransformGizmo(camera);
  gizmo.setObjects([obj]);
  gizmo.setMode(mode);
  if (space) gizmo.setSpace(space);
  gizmo.update();
  const before = obj.getWorldPosition(new THREE.Vector3()).clone();
  gizmo.beginDrag(handle, R0());
  gizmo.updateDrag(moveRay);
  const delta = obj.getWorldPosition(new THREE.Vector3()).clone().sub(before);
  gizmo.endDrag();
  return delta;
}

// 两个父节点：各自不同的旋转 + 非均匀缩放，两个对象局部位置也非零
function multiParentHarness() {
  const scene = new THREE.Scene();
  const camera = makeCamera();

  const parentA = new THREE.Group();
  parentA.name = 'parent-A';
  parentA.rotation.y = Math.PI / 4;
  parentA.scale.set(2, 0.5, 1.5);
  scene.add(parentA);

  const parentB = new THREE.Group();
  parentB.name = 'parent-B';
  parentB.rotation.set(0.3, -0.9, 0.2);
  parentB.scale.set(0.7, 2.4, 1.1);
  scene.add(parentB);

  const objA = createEquipment('workbench');
  objA.position.set(1.2, 0, -0.8);
  parentA.add(objA);

  const objB = createEquipment('cabinet');
  objB.position.set(-1.6, 0, 0.9);
  parentB.add(objB);

  scene.updateMatrixWorld(true);

  const gizmo = new TransformGizmo(camera);
  gizmo.setObjects([objA, objB]);
  gizmo.setMode('translate');
  gizmo.update();
  return { scene, camera, parentA, parentB, objA, objB, gizmo };
}

function localSnapshot(obj) {
  return {
    p: obj.position.toArray(),
    q: obj.quaternion.toArray(),
    s: obj.scale.toArray()
  };
}

function assertArrayClose(actual, expected, eps, msg) {
  assert.equal(actual.length, expected.length, `${msg} 长度不一致`);
  actual.forEach((v, i) => {
    assert.ok(Math.abs(v - expected[i]) <= eps, `${msg}[${i}]: 实际 ${v} vs 期望 ${expected[i]}`);
  });
}

const AXIS_HANDLE = { kind: 'axis', axis: 'x', mode: 'translate' };
const PLANE_HANDLE = { kind: 'plane', axis: 'z', mode: 'translate' };

test('多选轴平移：不同旋转/非均匀缩放父节点下，世界增量按各自父逆矩阵映射回局部', () => {
  const { gizmo, parentA, parentB, objA, objB } = multiParentHarness();
  const moveRay = ray(v3(0, 1, 8), v3(2, 0, -8));

  // 参考：主对象 A 单独拖同一意图得到的世界向量。多选时这个向量只算一次，
  // 然后原样施加给 B（B 不能按自己的锚点再求一次交，否则深度不同会得到不同位移）。
  const refDelta = referenceWorldMove({
    parentTransform: { rotation: [0, Math.PI / 4, 0], scale: [2, 0.5, 1.5] },
    localPos: [1.2, 0, -0.8], handle: AXIS_HANDLE, moveRay, mode: 'translate'
  });

  const worldA0 = objA.getWorldPosition(new THREE.Vector3());
  const worldB0 = objB.getWorldPosition(new THREE.Vector3());
  const localA0 = objA.position.clone();
  const localB0 = objB.position.clone();

  gizmo.beginDrag(AXIS_HANDLE, R0());
  gizmo.updateDrag(moveRay);

  // 世界姿态：两者都精确平移“同一个”参考世界向量（即使 B 锚点深度与 A 不同）
  const worldA1 = objA.getWorldPosition(new THREE.Vector3());
  const worldB1 = objB.getWorldPosition(new THREE.Vector3());
  assertArrayClose(worldA1.toArray(), worldA0.clone().add(refDelta).toArray(), 1e-7, 'A 世界位置');
  assertArrayClose(worldB1.toArray(), worldB0.clone().add(refDelta).toArray(), 1e-7, 'B 世界位置');
  // 两对象实际世界位移必须完全相同
  const gotA = worldA1.clone().sub(worldA0);
  const gotB = worldB1.clone().sub(worldB0);
  assertArrayClose(gotA.toArray(), gotB.toArray(), 1e-9, '多选世界位移必须逐对象相同');

  // 局部坐标：必须是各自世界目标点经“各自父逆矩阵”换算，而不是共用同一父变换
  const invA = parentA.matrixWorld.clone().invert();
  const invB = parentB.matrixWorld.clone().invert();
  const expectLocalA = worldA1.clone().applyMatrix4(invA);
  const expectLocalB = worldB1.clone().applyMatrix4(invB);
  assertArrayClose(objA.position.toArray(), expectLocalA.toArray(), 1e-8, 'A 局部位置应来自 parentA 逆矩阵');
  assertArrayClose(objB.position.toArray(), expectLocalB.toArray(), 1e-8, 'B 局部位置应来自 parentB 逆矩阵');

  // 父变换本身不能被“统一清空/重置”来规避换算
  assertArrayClose(parentA.scale.toArray(), [2, 0.5, 1.5], 1e-12, 'parentA 缩放不得被清空');
  assertArrayClose(parentB.scale.toArray(), [0.7, 2.4, 1.1], 1e-12, 'parentB 缩放不得被清空');
  assert.ok(Math.abs(parentA.rotation.y - Math.PI / 4) < 1e-12, 'parentA 旋转不得被清空');
  assert.ok(Math.abs(parentB.rotation.y + 0.9) < 1e-12, 'parentB 旋转不得被清空');

  // 两个对象的局部位移因父变换不同而必须不同（这正是混用父变换会出错的地方）
  const movedA = objA.position.clone().sub(localA0);
  const movedB = objB.position.clone().sub(localB0);
  assert.ok(movedA.distanceTo(movedB) > 1e-4, '不同父变换下局部位移不应相同');

  gizmo.endDrag();
});

test('多选平面平移：逐对象换算，世界位移与各自单拖参考一致', () => {
  const { gizmo, parentA, parentB, objA, objB } = multiParentHarness();
  const moveRay = ray(v3(0, 1, 8), v3(1.2, 0.8, -8));

  const refDelta = referenceWorldMove({
    parentTransform: { rotation: [0, Math.PI / 4, 0], scale: [2, 0.5, 1.5] },
    localPos: [1.2, 0, -0.8], handle: PLANE_HANDLE, moveRay, mode: 'translate'
  });

  const worldA0 = objA.getWorldPosition(new THREE.Vector3());
  const worldB0 = objB.getWorldPosition(new THREE.Vector3());
  gizmo.beginDrag(PLANE_HANDLE, R0());
  gizmo.updateDrag(moveRay);

  const worldA1 = objA.getWorldPosition(new THREE.Vector3());
  const worldB1 = objB.getWorldPosition(new THREE.Vector3());
  assertArrayClose(worldA1.toArray(), worldA0.clone().add(refDelta).toArray(), 1e-7, 'A 平面世界位移');
  assertArrayClose(worldB1.toArray(), worldB0.clone().add(refDelta).toArray(), 1e-7, 'B 平面世界位移');
  assertArrayClose(worldA1.clone().sub(worldA0).toArray(), worldB1.clone().sub(worldB0).toArray(), 1e-9, '平面多选世界位移相同');

  // 局部仍来自各自父逆
  const invA = parentA.matrixWorld.clone().invert();
  const invB = parentB.matrixWorld.clone().invert();
  assertArrayClose(objA.position.toArray(), worldA1.clone().applyMatrix4(invA).toArray(), 1e-8, 'A 平面局部换算');
  assertArrayClose(objB.position.toArray(), worldB1.clone().applyMatrix4(invB).toArray(), 1e-8, 'B 平面局部换算');
  assert.ok(objA.position.toArray().every(Number.isFinite) && objB.position.toArray().every(Number.isFinite));
  gizmo.endDrag();
});

test('取消拖动：pointercancel 后所有对象恢复拖动前局部位置/姿态/缩放原值', () => {
  const { gizmo, objA, objB } = multiParentHarness();
  const snapA = localSnapshot(objA);
  const snapB = localSnapshot(objB);

  gizmo.beginDrag(AXIS_HANDLE, R0());
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(3, 0, -8)));
  // 确实发生了移动，否则取消测试没有意义
  assert.ok(objA.position.distanceTo(new THREE.Vector3(...snapA.p)) > 1e-6, '拖动应当先改变 A');
  assert.ok(objB.position.distanceTo(new THREE.Vector3(...snapB.p)) > 1e-6, '拖动应当先改变 B');

  gizmo.cancelDrag();

  assertArrayClose(objA.position.toArray(), snapA.p, 1e-12, '取消后 A 位置恢复原值');
  assertArrayClose(objB.position.toArray(), snapB.p, 1e-12, '取消后 B 位置恢复原值');
  assertArrayClose(objA.quaternion.toArray(), snapA.q, 1e-12, '取消后 A 姿态恢复原值');
  assertArrayClose(objB.quaternion.toArray(), snapB.q, 1e-12, '取消后 B 姿态恢复原值');
  assertArrayClose(objA.scale.toArray(), snapA.s, 1e-12, '取消后 A 缩放恢复原值');
  assertArrayClose(objB.scale.toArray(), snapB.s, 1e-12, '取消后 B 缩放恢复原值');
  assert.equal(gizmo.dragging, false, '取消后拖拽状态复位');
});

test('取消拖动：旋转/缩放模式下取消同样逐对象恢复，而非清空父变换', () => {
  const { gizmo, parentA, parentB, objA, objB } = multiParentHarness();

  gizmo.setMode('rotate');
  gizmo.update();
  const qA0 = objA.quaternion.clone();
  const qB0 = objB.quaternion.clone();
  gizmo.beginDrag({ kind: 'ring', axis: 'y', mode: 'rotate' }, ray(v3(0, 5, 0), v3(1, -4, 0)));
  gizmo.updateDrag(ray(v3(0, 5, 0), v3(0, -4, -1)));
  assert.ok(objA.quaternion.angleTo(qA0) > 1e-6 && objB.quaternion.angleTo(qB0) > 1e-6, '旋转应已生效');
  gizmo.cancelDrag();
  assert.ok(objA.quaternion.angleTo(qA0) < 1e-10, '取消后 A 姿态还原');
  assert.ok(objB.quaternion.angleTo(qB0) < 1e-10, '取消后 B 姿态还原');

  gizmo.setMode('scale');
  gizmo.update();
  const sA0 = objA.scale.clone();
  const sB0 = objB.scale.clone();
  gizmo.beginDrag({ kind: 'scaleCenter', mode: 'scale' }, ray(v3(2, 1, 8), v3(0, 0, -1)));
  gizmo.updateDrag(ray(v3(4, 1, 8), v3(0, 0, -1)));
  assert.ok(objA.scale.distanceTo(sA0) > 1e-6 && objB.scale.distanceTo(sB0) > 1e-6, '缩放应已生效');
  gizmo.cancelDrag();
  assertArrayClose(objA.scale.toArray(), sA0.toArray(), 1e-10, '取消后 A 缩放还原');
  assertArrayClose(objB.scale.toArray(), sB0.toArray(), 1e-10, '取消后 B 缩放还原');

  // 父变换始终保持
  assertArrayClose(parentA.scale.toArray(), [2, 0.5, 1.5], 1e-12);
  assertArrayClose(parentB.scale.toArray(), [0.7, 2.4, 1.1], 1e-12);
});

test('多选往返：拖回起始射线，所有对象逐位回到基准（无累积漂移）', () => {
  const { gizmo, objA, objB } = multiParentHarness();
  const snapA = localSnapshot(objA);
  const snapB = localSnapshot(objB);

  const r0 = R0();
  const rFwd = ray(v3(0, 1, 8), v3(2.5, 0, -8));
  gizmo.beginDrag(AXIS_HANDLE, r0);
  gizmo.updateDrag(rFwd);
  gizmo.updateDrag(rFwd);
  gizmo.updateDrag(r0);

  assertArrayClose(objA.position.toArray(), snapA.p, 1e-10, 'A 往返还原');
  assertArrayClose(objB.position.toArray(), snapB.p, 1e-10, 'B 往返还原');
  gizmo.endDrag();
});

test('提交快照与 restore：endDrag 返回 before/after，restore 逐对象回滚（撤销内核）', () => {
  const { gizmo, objA, objB } = multiParentHarness();
  gizmo.beginDrag(AXIS_HANDLE, R0());
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(3, 0, -8)));
  const movedA = objA.position.clone();
  const movedB = objB.position.clone();
  const commit = gizmo.endDrag();

  assert.ok(commit && Array.isArray(commit.before) && commit.before.length === 2, '提交应含两个对象的快照');
  assert.deepEqual(commit.objects, [objA, objB]);
  assertArrayClose(commit.after[0].position, movedA.toArray(), 1e-12, 'after 反映拖动结果 A');
  assertArrayClose(commit.after[1].position, movedB.toArray(), 1e-12, 'after 反映拖动结果 B');

  // 撤销：内核 restore 把对象回滚到 before
  gizmo.restore(commit.before);
  assertArrayClose(objA.position.toArray(), commit.before[0].position, 1e-12, '撤销后 A 回到 before');
  assertArrayClose(objB.position.toArray(), commit.before[1].position, 1e-12, '撤销后 B 回到 before');
});

test('边界回归：极端非均匀父缩放 + 非零局部偏移，多选换算有限且不被默认值遮错', () => {
  const scene = new THREE.Scene();
  const camera = makeCamera();
  const parent = new THREE.Group();
  parent.rotation.set(0.4, 0.7, -0.2);
  parent.scale.set(1000, 0.001, 3.2); // 极端非均匀
  scene.add(parent);
  const obj = createEquipment('analyzer');
  obj.position.set(3.5, 0, -2.1);
  parent.add(obj);
  scene.updateMatrixWorld(true);

  const gizmo = new TransformGizmo(camera);
  gizmo.setObjects([obj]);
  gizmo.setMode('translate');
  gizmo.update();

  // 参考：同场景单拖得到的世界位移与局部结果
  const w0 = obj.getWorldPosition(new THREE.Vector3());
  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, R0());
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(2, 0, -8)));
  const w1 = obj.getWorldPosition(new THREE.Vector3());

  // 世界位移只沿 X，Y/Z 不被极端父缩放污染
  assert.ok(Math.abs(w1.y - w0.y) < 1e-6, 'Y 分量不动');
  assert.ok(Math.abs(w1.z - w0.z) < 1e-6, 'Z 分量不动');
  assert.ok(Math.abs(w1.x - w0.x) > 1e-6, 'X 必须确实移动');
  // 局部坐标必须有限，且保留非零偏移——不允许用归零/默认值掩盖换算
  assert.ok(obj.position.toArray().every(Number.isFinite), '局部坐标必须全部有限');
  assert.ok(Math.abs(obj.position.x) > 1e-6 && Math.abs(obj.position.z) > 1e-6, '局部偏移不得被清零遮错');
  // 与父逆矩阵直接换算一致
  const expect = w1.clone().applyMatrix4(parent.matrixWorld.clone().invert());
  assertArrayClose(obj.position.toArray(), expect.toArray(), 1e-8, '极端父缩放下仍走父逆换算');
  gizmo.endDrag();
});

test('单选 API 向后兼容：attach/pick/单对象拖拽行为保持不变', () => {
  const scene = new THREE.Scene();
  const camera = makeCamera();
  const obj = createEquipment('workbench');
  scene.add(obj);
  scene.updateMatrixWorld(true);
  const gizmo = new TransformGizmo(camera);
  gizmo.attach(obj);
  gizmo.setMode('translate');
  gizmo.update();
  assert.equal(gizmo.object, obj);
  assert.deepEqual(gizmo.objects, [obj]);

  const anchor = obj.getWorldPosition(new THREE.Vector3());
  gizmo.beginDrag({ kind: 'axis', axis: 'x', mode: 'translate' }, R0());
  gizmo.updateDrag(ray(v3(0, 1, 8), v3(1.5, 0, -8)));
  const wp = obj.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(wp.x - (anchor.x + 1.5)) < 1e-8);
  gizmo.endDrag();
});
