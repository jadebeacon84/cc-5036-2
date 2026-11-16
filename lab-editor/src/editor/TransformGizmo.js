import * as THREE from 'three';
import {
  rayAxis,
  rayPlane,
  signedAngleInPlane,
  gizmoWorldSize,
  clamp
} from './math3d.js';

const AXIS_VECTORS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
};
const AXIS_COLORS = { x: 0xff5252, y: 0x51ff7a, z: 0x5393ff };
const MIN_SCALE = 0.02;
const MAX_SCALE = 200;
const PARALLEL_THRESHOLD = 1e-8; // sin²(夹角) 小于此值即判定退化（约 0.0057°）

const v3 = (v) => [v.x, v.y, v.z];

/**
 * 自定义三维变换操纵器。
 * 设计要点：
 *  1. 射线-轴/平面求交全部走 math3d 的稳定实现，分母趋零时显式退化，绝不除零；
 *  2. 拖拽开始保存基准快照，每次 move 都从快照按“同一意图”重新计算，
 *     不做增量累加，往返拖动可精确回到原位；
 *  3. 操纵器世界尺度按相机参数独立计算，与被操纵对象几何尺度无关；
 *  4. 不绑定 DOM：外部注入 THREE.Ray，便于在 Node 下用合成射线测试。
 */
export class TransformGizmo {
  constructor(camera) {
    this.camera = camera;
    this.object = null;
    this.mode = 'translate'; // translate | rotate | scale
    this.space = 'world'; // world | local
    this.group = new THREE.Group();
    this.group.name = 'transform-gizmo';
    this.group.visible = false;
    this.pickMeshes = [];
    this.raycaster = new THREE.Raycaster();
    this.dragging = false;
    this.onChange = null;
    this.onStatus = null;

    this._buildHandles();
    this._setModeVisibility();
  }

  // ---------- 构建 ----------

  _material(color) {
    // depthTest 关闭 + 高 renderOrder：即使被模型遮挡或模型极小也能操作
    return new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });
  }

  _pickMaterial() {
    // 不可见但仍可被 Raycaster 命中的加厚拾取代理
    const m = new THREE.MeshBasicMaterial();
    m.visible = false;
    return m;
  }

  _tag(mesh, handle) {
    mesh.userData.handle = handle;
    mesh.renderOrder = 999;
    this.pickMeshes.push(mesh);
    return mesh;
  }

  _addVisual(mesh, mode) {
    mesh.userData.visualMode = mode;
    mesh.renderOrder = 998;
    this.group.add(mesh);
    return mesh;
  }

  _buildHandles() {
    const axes = ['x', 'y', 'z'];

    // 平移：箭头轴 + 双轴平面块
    for (const axis of axes) {
      const color = AXIS_COLORS[axis];
      const dir = AXIS_VECTORS[axis];

      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.015, 0.015, 0.85, 12),
        this._material(color)
      );
      shaft.position.copy(dir).multiplyScalar(0.425);
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this._addVisual(shaft, 'translate');

      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.06, 0.16, 20),
        this._material(color)
      );
      cone.position.copy(dir).multiplyScalar(0.92);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      this._addVisual(cone, 'translate');

      const proxy = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 1.0, 8),
        this._pickMaterial()
      );
      proxy.position.copy(dir).multiplyScalar(0.5);
      proxy.quaternion.copy(shaft.quaternion);
      this.group.add(this._tag(proxy, { kind: 'axis', axis, mode: 'translate' }));
    }

    const planeDefs = [
      { axis: 'z', normal: new THREE.Vector3(0, 0, 1), pos: new THREE.Vector3(0.22, 0.22, 0), rot: [0, 0, 0] },
      { axis: 'y', normal: new THREE.Vector3(0, 1, 0), pos: new THREE.Vector3(0.22, 0, 0.22), rot: [Math.PI / 2, 0, 0] },
      { axis: 'x', normal: new THREE.Vector3(1, 0, 0), pos: new THREE.Vector3(0, 0.22, 0.22), rot: [0, -Math.PI / 2, 0] }
    ];
    for (const p of planeDefs) {
      const color = AXIS_COLORS[p.axis];
      const square = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.22),
        this._material(color)
      );
      square.position.copy(p.pos);
      square.rotation.set(...p.rot);
      this._addVisual(square, 'translate');

      const proxy = new THREE.Mesh(
        new THREE.PlaneGeometry(0.34, 0.34),
        this._pickMaterial()
      );
      proxy.position.copy(p.pos);
      proxy.rotation.copy(square.rotation);
      this.group.add(this._tag(proxy, { kind: 'plane', axis: p.axis, mode: 'translate' }));
    }

    // 旋转：圆环（环面法向 = 对应轴）
    for (const axis of axes) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.014, 10, 48),
        this._material(AXIS_COLORS[axis])
      );
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), AXIS_VECTORS[axis]);
      this._addVisual(ring, 'rotate');

      const proxy = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.07, 8, 32),
        this._pickMaterial()
      );
      proxy.quaternion.copy(ring.quaternion);
      this.group.add(this._tag(proxy, { kind: 'ring', axis, mode: 'rotate' }));
    }

    // 缩放：轴端方块 + 中心等比方块
    for (const axis of axes) {
      const dir = AXIS_VECTORS[axis];
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.1),
        this._material(AXIS_COLORS[axis])
      );
      box.position.copy(dir).multiplyScalar(0.95);
      this._addVisual(box, 'scale');

      const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.22, 0.22),
        this._pickMaterial()
      );
      proxy.position.copy(box.position);
      this.group.add(this._tag(proxy, { kind: 'scaleAxis', axis, mode: 'scale' }));
    }
    const center = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.14),
      this._material(0xffffff)
    );
    this._addVisual(center, 'scale');
    const centerProxy = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 10),
      this._pickMaterial()
    );
    this.group.add(this._tag(centerProxy, { kind: 'scaleCenter', mode: 'scale' }));
  }

  _setModeVisibility() {
    for (const mesh of this.group.children) {
      if (mesh.userData.handle) {
        mesh.visible = mesh.userData.handle.mode === this.mode;
      } else if (mesh.userData.visualMode) {
        mesh.visible = mesh.userData.visualMode === this.mode;
      }
    }
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this._setModeVisibility();
  }

  setSpace(space) {
    this.space = space; // 缩放始终使用局部轴，见 _activeAxes
  }

  attach(object) {
    this.object = object;
    this.group.visible = true;
  }

  detach() {
    this.object = null;
    this.group.visible = false;
    this.dragging = false;
  }

  // ---------- 每帧更新：位置/朝向/屏幕恒定尺度 ----------

  update() {
    if (!this.object) return;
    this.object.updateWorldMatrix(true, false);
    const worldPos = this.object.getWorldPosition(new THREE.Vector3());
    this.group.position.copy(worldPos);

    const useLocal = this.space === 'local' || this.mode === 'scale';
    if (useLocal) {
      this.object.getWorldQuaternion(this.group.quaternion);
    } else {
      this.group.quaternion.identity();
    }

    const cam = this.camera;
    let size;
    if (cam.isOrthographicCamera) {
      const viewHeight = (cam.top - cam.bottom) / Math.max(cam.zoom, 1e-6);
      size = gizmoWorldSize({ projection: 'orthographic', viewHeight });
    } else {
      const dist = cam.position.distanceTo(worldPos);
      size = gizmoWorldSize({
        projection: 'perspective',
        distance: dist,
        fovY: cam.fov
      });
    }
    this.group.scale.setScalar(size);
    this.group.updateMatrixWorld(true);
  }

  // ---------- 拾取 ----------

  pick(ray) {
    if (!this.object) return null;
    this.raycaster.set(ray.origin, ray.direction);
    const candidates = this.pickMeshes.filter((m) => m.userData.handle.mode === this.mode);
    const hits = this.raycaster.intersectObjects(candidates, false);
    if (!hits.length) return null;
    return hits[0].object.userData.handle;
  }

  // ---------- 拖拽（快照基准，不累积误差） ----------

  beginDrag(handle, ray) {
    const obj = this.object;
    if (!obj) return;
    obj.updateWorldMatrix(true, false);
    const parent = obj.parent;
    parent.updateWorldMatrix(true, false);

    const base = {
      handle,
      localPosition: obj.position.clone(),
      localQuaternion: obj.quaternion.clone(),
      localScale: obj.scale.clone(),
      worldPosition: obj.getWorldPosition(new THREE.Vector3()),
      worldQuaternion: obj.getWorldQuaternion(new THREE.Quaternion()),
      parentWorldInverse: parent.matrixWorld.clone().invert(),
      gizmoSize: this.group.scale.x,
      ray0: { origin: ray.origin.clone(), direction: ray.direction.clone() }
    };
    const parentPos = new THREE.Vector3();
    const parentQuat = new THREE.Quaternion();
    const parentScale = new THREE.Vector3();
    parent.matrixWorld.decompose(parentPos, parentQuat, parentScale);
    base.parentQuaternion = parentQuat.clone();

    // 当前生效的世界坐标轴方向
    const axes = {};
    const basisQ = this.mode === 'scale' || this.space === 'local'
      ? base.worldQuaternion
      : new THREE.Quaternion();
    for (const a of ['x', 'y', 'z']) {
      axes[a] = AXIS_VECTORS[a].clone().applyQuaternion(basisQ).normalize();
    }
    base.axes = axes;
    base.viewDir = this._viewDirection();

    this.drag = base;
    this.dragging = true;
    this._degraded = false;
    this._noteDegradation(false, '');
    return base;
  }

  _viewDirection() {
    const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
    return new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  }

  _setStatus(msg) {
    if (this.onStatus) this.onStatus(msg);
  }

  _noteDegradation(degraded, msg) {
    if (degraded !== this._degraded || degraded) this._setStatus(msg);
    this._degraded = degraded;
  }

  updateDrag(ray) {
    if (!this.dragging || !this.object) return;
    const d = this.drag;
    const handle = d.handle;
    const dir = ray.direction;
    const origin = ray.origin;

    if (handle.mode === 'translate') {
      if (handle.kind === 'axis') this._dragTranslateAxis(d, origin, dir);
      else this._dragTranslatePlane(d, origin, dir);
    } else if (handle.mode === 'rotate') {
      this._dragRotate(d, origin, dir);
    } else {
      if (handle.kind === 'scaleCenter') this._dragScaleUniform(d, origin, dir);
      else this._dragScaleAxis(d, origin, dir);
    }
    if (this.onChange) this.onChange(this.object);
  }

  // 轴与视线接近平行时的退化平面：必须包含该轴，且尽量朝向相机。
  // 取另外两条坐标轴中与视线夹角最小者作为平面法向，
  // 这样平面包含操纵轴，拖动在轴上的分量不会被投影掉。
  _degeneratePlaneNormal(axisName) {
    const others = ['x', 'y', 'z'].filter((a) => a !== axisName);
    let best = others[0];
    let bestScore = -1;
    for (const a of others) {
      const score = Math.abs(this.drag.axes[a].dot(this.drag.viewDir));
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return this.drag.axes[best];
  }

  _dragTranslateAxis(d, origin, dir) {
    const axis = d.axes[d.handle.axis];
    const anchor = d.worldPosition;
    const r0 = rayAxis(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), v3(axis), PARALLEL_THRESHOLD);
    const r1 = rayAxis(v3(origin), v3(dir), v3(anchor), v3(axis), PARALLEL_THRESHOLD);

    let delta;
    if (r1.parallel || r0.parallel) {
      // 退化策略：改用包含该轴、最朝向相机的坐标平面，取交点在轴上的分量
      const n = this._degeneratePlaneNormal(d.handle.axis);
      const a = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), v3(n), PARALLEL_THRESHOLD);
      const b = rayPlane(v3(origin), v3(dir), v3(anchor), v3(n), PARALLEL_THRESHOLD);
      const p0 = new THREE.Vector3(...a.point);
      const p1 = new THREE.Vector3(...b.point);
      delta = p1.sub(p0).dot(axis);
      this._noteDegradation(true, `视线接近 ${d.handle.axis.toUpperCase()} 轴：已切换为包含该轴的退化平面约束`);
    } else {
      delta = r1.s - r0.s;
      this._noteDegradation(false, '');
    }
    if (!Number.isFinite(delta)) return; // 最后防线：拒绝非法值，物体保持不动
    const world = anchor.clone().addScaledVector(axis, delta);
    this._applyWorldPosition(world, d);
  }

  _dragTranslatePlane(d, origin, dir) {
    const normalAxis = d.handle.axis; // 平面法向对应的轴
    let normal = d.axes[normalAxis];
    const anchor = d.worldPosition;

    let r0 = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), v3(normal), PARALLEL_THRESHOLD);
    let r1 = rayPlane(v3(origin), v3(dir), v3(anchor), v3(normal), PARALLEL_THRESHOLD);

    if (r0.parallel || r1.parallel) {
      // 退化：平面被看成一条线时，改取最朝向相机的坐标平面
      let best = 'x';
      let bestDot = -1;
      for (const a of ['x', 'y', 'z']) {
        const score = Math.abs(d.axes[a].dot(d.viewDir));
        if (score > bestDot) { bestDot = score; best = a; }
      }
      normal = d.axes[best];
      r0 = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), v3(normal), PARALLEL_THRESHOLD);
      r1 = rayPlane(v3(origin), v3(dir), v3(anchor), v3(normal), PARALLEL_THRESHOLD);
      this._noteDegradation(true, `平面与视线接近平行：已切换到最朝向相机的 ${best.toUpperCase()} 法向平面`);
    } else {
      this._noteDegradation(false, '');
    }
    if (r0.parallel || r1.parallel) return; // 极端情况保持不动，绝不飞走
    const p0 = new THREE.Vector3(...r0.point);
    const p1 = new THREE.Vector3(...r1.point);
    const world = anchor.clone().add(p1.sub(p0));
    this._applyWorldPosition(world, d);
  }

  _dragRotate(d, origin, dir) {
    const axis = d.axes[d.handle.axis];
    const anchor = d.worldPosition;
    const nAxis = v3(axis);
    const r0 = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), nAxis, PARALLEL_THRESHOLD);
    const r1 = rayPlane(v3(origin), v3(dir), v3(anchor), nAxis, PARALLEL_THRESHOLD);

    let angle;
    if (r0.parallel || r1.parallel) {
      // 环被看成一条线：在视图平面内测角，用轴与视线的朝向修正符号
      const n = v3(d.viewDir);
      const a0 = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), n, PARALLEL_THRESHOLD);
      const a1 = rayPlane(v3(origin), v3(dir), v3(anchor), n, PARALLEL_THRESHOLD);
      const dir0 = new THREE.Vector3(...a0.point).sub(anchor);
      const dir1 = new THREE.Vector3(...a1.point).sub(anchor);
      angle = signedAngleInPlane(v3(dir0), v3(dir1), n);
      if (axis.dot(d.viewDir) < 0) angle = -angle;
      this._noteDegradation(true, `旋转环与视线接近平行：已切换为视图平面测角`);
    } else {
      const dir0 = new THREE.Vector3(...r0.point).sub(anchor);
      const dir1 = new THREE.Vector3(...r1.point).sub(anchor);
      angle = signedAngleInPlane(v3(dir0), v3(dir1), nAxis);
      this._noteDegradation(false, '');
    }
    if (!Number.isFinite(angle)) return;

    const qDelta = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    if (this.space === 'local' && this.mode === 'rotate') {
      // 局部旋转：右乘到基准局部姿态
      const qLocalAxis = new THREE.Quaternion().setFromAxisAngle(AXIS_VECTORS[d.handle.axis], angle);
      this.object.quaternion.copy(d.localQuaternion).multiply(qLocalAxis);
    } else {
      // 世界旋转：左乘到基准世界姿态，再换回父节点局部空间
      const qWorld = qDelta.multiply(d.worldQuaternion);
      const qLocal = d.parentQuaternion.clone().invert().multiply(qWorld);
      this.object.quaternion.copy(qLocal);
    }
  }

  _dragScaleAxis(d, origin, dir) {
    // 缩放始终沿局部轴（非均匀缩放的语义要求），axis 已用世界姿态换算
    const axis = d.axes[d.handle.axis];
    const anchor = d.worldPosition;
    const r0 = rayAxis(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), v3(axis), PARALLEL_THRESHOLD);
    const r1 = rayAxis(v3(origin), v3(dir), v3(anchor), v3(axis), PARALLEL_THRESHOLD);

    let delta;
    if (r0.parallel || r1.parallel) {
      const n = this._degeneratePlaneNormal(d.handle.axis);
      const a = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), v3(n), PARALLEL_THRESHOLD);
      const b = rayPlane(v3(origin), v3(dir), v3(anchor), v3(n), PARALLEL_THRESHOLD);
      delta = new THREE.Vector3(...b.point).sub(new THREE.Vector3(...a.point)).dot(axis);
      this._noteDegradation(true, `视线接近缩放轴：已切换为包含该轴的退化平面约束`);
    } else {
      delta = r1.s - r0.s;
      this._noteDegradation(false, '');
    }
    if (!Number.isFinite(delta)) return;
    const factor = 1 + delta / Math.max(d.gizmoSize, 1e-6);
    const next = d.localScale.clone();
    const comp = next[d.handle.axis] * factor;
    next[d.handle.axis] = clamp(comp, MIN_SCALE, MAX_SCALE);
    this.object.scale.copy(next);
  }

  _dragScaleUniform(d, origin, dir) {
    const n = v3(d.viewDir);
    const anchor = d.worldPosition;
    const r0 = rayPlane(v3(d.ray0.origin), v3(d.ray0.direction), v3(anchor), n, PARALLEL_THRESHOLD);
    const r1 = rayPlane(v3(origin), v3(dir), v3(anchor), n, PARALLEL_THRESHOLD);
    if (r0.parallel || r1.parallel) {
      this._noteDegradation(true, '等比缩放：视线与约束平面平行，本次移动忽略');
      return;
    }
    const dist0 = Math.max(new THREE.Vector3(...r0.point).sub(anchor).length(), 1e-6);
    const dist1 = new THREE.Vector3(...r1.point).sub(anchor).length();
    const factor = dist1 / dist0;
    if (!Number.isFinite(factor)) return;
    const next = d.localScale.clone().multiplyScalar(factor);
    next.x = clamp(next.x, MIN_SCALE, MAX_SCALE);
    next.y = clamp(next.y, MIN_SCALE, MAX_SCALE);
    next.z = clamp(next.z, MIN_SCALE, MAX_SCALE);
    this.object.scale.copy(next);
    this._noteDegradation(false, '');
  }

  _applyWorldPosition(worldPos, d) {
    const local = worldPos.clone().applyMatrix4(d.parentWorldInverse);
    this.object.position.copy(local);
  }

  endDrag() {
    this.dragging = false;
    this.drag = null;
    this._noteDegradation(false, '就绪');
  }
}
