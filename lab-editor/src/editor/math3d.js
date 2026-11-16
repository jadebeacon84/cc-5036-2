// 纯向量/求交数学，不依赖任何渲染库，便于在 Node 下单元测试。
// 向量统一使用 [x, y, z] 普通数组；射线方向必须是单位向量。

export const EPS = 1e-9;

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a) {
  const len = length(a);
  if (len < EPS) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 射线与无限直线的最近点求交（稳定版）。
 * 射线：origin + t * dir；直线：linePoint + s * lineDir（lineDir 为单位向量）。
 *
 * 返回 { s, point, parallel }：
 *  - s 是沿操纵轴的有符号参数（相对 linePoint），单轴拖拽直接使用；
 *  - point 是射线上最接近直线的点（退化时退化为直线上的垂足）；
 *  - parallel 为 true 表示视线与轴接近平行，调用方必须改用平面约束。
 *
 * 关键：当 |dir · axis| 接近 1 时分母接近 0，不做除法，直接标记 parallel，
 * 由上层切换到明确的退化策略，避免 NaN/极大值把物体“弹飞”。
 */
export function rayAxis(origin, dir, linePoint, lineDir, parallelThreshold = 1e-8) {
  const axis = normalize(lineDir);
  const d = dot(dir, axis);
  const denom = 1 - d * d; // sin^2(夹角)
  if (denom <= parallelThreshold) {
    // 退化：视线与轴近乎平行。垂足仍可稳定计算，但不提供轴上位置。
    const rel = sub(linePoint, origin);
    const s0 = dot(rel, axis);
    const point = add(linePoint, scale(axis, s0));
    return { s: s0, point, parallel: true };
  }
  const rel = sub(linePoint, origin);
  // 最小二乘：最小化 |origin + t dir - (linePoint + s axis)|^2
  const t = (dot(rel, dir) - d * dot(rel, axis)) / denom;
  const closestOnRay = add(origin, scale(dir, t));
  const s = dot(sub(closestOnRay, linePoint), axis);
  if (!Number.isFinite(s) || !Number.isFinite(t)) {
    const s0 = dot(rel, axis);
    return { s: s0, point: add(linePoint, scale(axis, s0)), parallel: true };
  }
  return { s, point: closestOnRay, parallel: false };
}

/**
 * 射线与平面求交（稳定版）。平面：过 planePoint，法向 normal（单位向量）。
 * 返回 { point, t, parallel }。视线与平面近乎平行时标记 parallel，
 * 不做 1/0 除法。
 */
export function rayPlane(origin, dir, planePoint, normal, parallelThreshold = 1e-8) {
  const n = normalize(normal);
  const denom = dot(dir, n);
  if (Math.abs(denom) <= parallelThreshold) {
    return { point: planePoint.slice(), t: 0, parallel: true };
  }
  const t = dot(sub(planePoint, origin), n) / denom;
  if (!Number.isFinite(t)) {
    return { point: planePoint.slice(), t: 0, parallel: true };
  }
  return { point: add(origin, scale(dir, t)), t, parallel: false };
}

/**
 * 操纵器在世界空间的统一尺度，使其在屏幕上保持固定视觉大小，
 * 与被操纵对象自身的几何尺度完全解耦。
 *  - 透视相机：按视距比例缩放，并做近/远距离钳制；
 *  - 正交相机：世界尺度恒定（与位置无关），由可视高度决定。
 * 无论模型很大或很小，操纵器手感一致。
 */
export function gizmoWorldSize(opts) {
  const {
    projection = 'perspective',
    distance = 10,
    fovY = 50, // 透视：垂直视场角（度）
    viewHeight = 10, // 正交：可视世界高度
    screenFraction = 0.18, // 操纵器占视口高度的目标比例
    minSize = 0.2,
    maxSize = 1e4
  } = opts;
  let size;
  if (projection === 'orthographic') {
    size = viewHeight * screenFraction;
  } else {
    const fovRad = (fovY * Math.PI) / 180;
    const worldHeightAtTarget = 2 * Math.abs(distance) * Math.tan(fovRad / 2);
    size = worldHeightAtTarget * screenFraction;
  }
  if (!Number.isFinite(size) || size <= 0) return minSize;
  return clamp(size, minSize, maxSize);
}

/**
 * 两条从同一点出发的方向在给定法向平面上的有符号夹角（弧度，[-PI, PI]）。
 * 方向会先投影到平面再归一化；投影退化（方向与法向平行）时返回 0，
 * 由上层决定是否退化处理，保证旋转数值始终有限。
 */
export function signedAngleInPlane(dirA, dirB, normal) {
  const n = normalize(normal);
  const project = (v) => sub(v, scale(n, dot(v, n)));
  const a = normalize(project(dirA));
  const b = normalize(project(dirB));
  if (length(a) < EPS || length(b) < EPS) return 0;
  const cos = clamp(dot(a, b), -1, 1);
  const ang = Math.acos(cos);
  return dot(cross(a, b), n) >= 0 ? ang : -ang;
}

/**
 * 两向量的绝对夹角（弧度），用于判断视线与轴/平面的接近程度。
 */
export function angleBetween(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (length(na) < EPS || length(nb) < EPS) return 0;
  return Math.acos(clamp(dot(na, nb), -1, 1));
}
