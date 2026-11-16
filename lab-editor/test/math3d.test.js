import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rayAxis,
  rayPlane,
  signedAngleInPlane,
  gizmoWorldSize,
  angleBetween,
  normalize,
  cross
} from '../src/editor/math3d.js';

test('rayAxis：正交视线命中轴上已知点，参数 s 正确', () => {
  // 视线沿 -Z，轴为 X 轴、过原点
  const r = rayAxis([0, 0, 5], [0, 0, -1], [0, 0, 0], [1, 0, 0]);
  assert.equal(r.parallel, false);
  assert.ok(Math.abs(r.s) < 1e-9);
  assert.ok(Math.abs(r.point[2]) < 1e-9);

  const r2 = rayAxis([0, 0, 5], [0, 0, -1], [3, 0, 0], [1, 0, 0]);
  assert.ok(Math.abs(r2.s + 3) < 1e-9, '射线最近点在轴原点，相对锚点 (3,0,0) 的参数应为 -3');
});

test('rayAxis：斜射时返回最近点，有限且稳定', () => {
  const r = rayAxis([2, 1, 4], normalize([-1, -0.3, -1]), [0, 0, 0], [0, 1, 0]);
  assert.equal(r.parallel, false);
  assert.ok(Number.isFinite(r.s));
  assert.ok(Number.isFinite(r.point[0]));
});

test('rayAxis：视线与轴接近平行时显式标记 parallel，不产生 NaN/Inf', () => {
  // 视线几乎沿 +X，轴也是 X：经典 1/0 退化场景
  const nearParallelDir = normalize([1, 0, 5e-5]); // sin² 约 2.5e-9，低于阈值
  const r = rayAxis([0, 0.0001, 5], nearParallelDir, [0, 0, 0], [1, 0, 0]);
  assert.equal(r.parallel, true);
  assert.ok(Number.isFinite(r.s));
  assert.ok(r.point.every(Number.isFinite));

  // 完全平行的极限情况
  const exact = rayAxis([0, 1, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0]);
  assert.equal(exact.parallel, true);
  assert.ok(exact.point.every(Number.isFinite));
});

test('rayAxis：输入非单位轴方向也能归一化处理', () => {
  const r = rayAxis([0, 0, 5], [0, 0, -1], [0, 0, 0], [5, 0, 0]);
  assert.equal(r.parallel, false);
  assert.ok(Math.abs(r.s) < 1e-9);
});

test('rayPlane：正面命中返回正确交点与有限 t', () => {
  const r = rayPlane([0, 0, 5], [0, 0, -1], [0, 0, 0], [0, 0, 1]);
  assert.equal(r.parallel, false);
  assert.ok(Math.abs(r.point[2]) < 1e-9);
  assert.ok(Math.abs(r.t - 5) < 1e-9);
});

test('rayPlane：视线与平面平行时退化且不除零', () => {
  const r = rayPlane([0, 0, 3], [1, 0, 0], [0, 0, 0], [0, 0, 1]);
  assert.equal(r.parallel, true);
  assert.ok(r.point.every(Number.isFinite));
});

test('signedAngleInPlane：符号由法向右手定则决定', () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  const n = [0, 0, 1];
  const ang = signedAngleInPlane(a, b, n);
  assert.ok(Math.abs(ang - Math.PI / 2) < 1e-9);
  const angReverse = signedAngleInPlane(b, a, n);
  assert.ok(Math.abs(angReverse + Math.PI / 2) < 1e-9);
});

test('signedAngleInPlane：方向落在法向（投影退化）时返回 0 而非 NaN', () => {
  const ang = signedAngleInPlane([0, 0, 1], [0, 0, 1], [0, 0, 1]);
  assert.equal(ang, 0);
});

test('gizmoWorldSize：透视下随视距线性增长，屏幕占比恒定', () => {
  const near = gizmoWorldSize({ projection: 'perspective', distance: 5, fovY: 50 });
  const far = gizmoWorldSize({ projection: 'perspective', distance: 50, fovY: 50 });
  assert.ok(Math.abs(far / near - 10) < 1e-7);
});

test('gizmoWorldSize：正交下与视距无关，只随可视高度变化', () => {
  const s1 = gizmoWorldSize({ projection: 'orthographic', viewHeight: 10 });
  const s2 = gizmoWorldSize({ projection: 'orthographic', viewHeight: 20 });
  assert.ok(Math.abs(s2 / s1 - 2) < 1e-9);
});

test('gizmoWorldSize：非有限输入回退到最小尺度，不返回 0/负数', () => {
  const s = gizmoWorldSize({ projection: 'perspective', distance: Infinity, fovY: 50 });
  assert.ok(s > 0 && Number.isFinite(s));
  const s0 = gizmoWorldSize({ projection: 'perspective', distance: 0, fovY: 50 });
  assert.ok(s0 >= 0.2 - 1e-9);
});

test('angleBetween 与叉积：基础几何一致', () => {
  assert.ok(Math.abs(angleBetween([1, 0, 0], [0, 1, 0]) - Math.PI / 2) < 1e-9);
  const c = cross([1, 0, 0], [0, 1, 0]);
  assert.deepEqual(c, [0, 0, 1]);
});
