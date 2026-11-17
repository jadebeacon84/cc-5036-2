import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformGizmo } from './editor/TransformGizmo.js';
import { createEquipment, EQUIPMENT_TYPES, equipmentLabel, makeBoxHelper } from './editor/equipment.js';
import { createScene, rayFromPointer, rayFromNDC, swapCameraProjection, resizeCameras } from './editor/scene.js';
import {
  serializeLayout,
  applyLayout,
  saveToLocalStorage,
  loadFromLocalStorage,
  downloadLayout,
  validateLayout
} from './editor/layout.js';

const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let aspect = window.innerWidth / window.innerHeight;
let perspectiveCam = new THREE.PerspectiveCamera(50, aspect, 0.1, 500);
perspectiveCam.position.set(9, 8, 11);
let orthoCam = null;
let camera = perspectiveCam;

const { scene, ground } = createScene();
const equipmentRoot = new THREE.Group();
equipmentRoot.name = 'equipment-root';
scene.add(equipmentRoot);

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.target.set(0, 0.8, 0);

const gizmo = new TransformGizmo(camera);
scene.add(gizmo.group);
gizmo.onStatus = (msg) => setStatus(msg);

// 多选高亮：每个选中设备一个 BoxHelper
const selectionHelpers = [];
function refreshSelectionHelpers() {
  while (selectionHelpers.length) {
    const helper = selectionHelpers.pop();
    scene.remove(helper);
    helper.geometry?.dispose?.();
    helper.material?.dispose?.();
  }
  for (const obj of selectedSet) {
    const helper = new THREE.BoxHelper(obj, 0xffeb3b);
    scene.add(helper);
    selectionHelpers.push(helper);
  }
}

// 变换撤销栈：只记录变换操纵产生的 before/after 局部快照（由 gizmo 内核生成）
const undoStack = [];
const MAX_UNDO = 50;
const undoBtn = document.getElementById('undo-btn');
function updateUndoButton() {
  undoBtn.disabled = undoStack.length === 0;
}
function pushUndo(commit) {
  if (!commit || !commit.before?.length) return;
  undoStack.push(commit);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoButton();
}
function undoLast() {
  const commit = undoStack.pop();
  if (!commit) return;
  gizmo.restore(commit.before);
  updateUndoButton();
  refreshSceneList();
  updateInspector();
  scheduleAutosave();
  setStatus(`已撤销变换，剩余可撤销 ${undoStack.length} 步`);
}
undoBtn.addEventListener('click', undoLast);

// 选中集合（保持插入顺序）；selected 是主对象（操纵器锚点 = 集合第一个）
const selectedSet = [];
let selected = null;
let autosaveTimer = null;

// ---------- 状态栏 ----------
const statusEl = document.getElementById('status-line');
function setStatus(msg) {
  statusEl.textContent = msg;
}

// ---------- 设备库 / 场景列表 ----------
const equipmentListEl = document.getElementById('equipment-list');
const sceneListEl = document.getElementById('scene-list');
const deleteBtn = document.getElementById('delete-btn');

for (const type of EQUIPMENT_TYPES) {
  const li = document.createElement('li');
  li.textContent = `＋ ${equipmentLabel(type)}`;
  li.className = 'add-item';
  li.addEventListener('click', () => addEquipment(type));
  equipmentListEl.appendChild(li);
}

function addEquipment(type, preset) {
  const obj = createEquipment(type);
  if (preset) {
    obj.userData.id = preset.id || obj.userData.id;
    obj.position.set(...preset.position);
    if (preset.rotation) obj.rotation.set(...preset.rotation);
    if (preset.scale) obj.scale.set(...preset.scale);
  } else {
    obj.position.set((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4);
  }
  equipmentRoot.add(obj);
  selectObject(obj);
  refreshSceneList();
  scheduleAutosave();
  setStatus(`已添加：${obj.userData.label}`);
  return obj;
}

function refreshSceneList() {
  sceneListEl.innerHTML = '';
  equipmentRoot.children.forEach((obj) => {
    const li = document.createElement('li');
    li.textContent = obj.userData.label;
    li.className = selectedSet.includes(obj) ? 'scene-item selected' : 'scene-item';
    li.addEventListener('click', (ev) => selectObject(obj, ev.shiftKey));
    sceneListEl.appendChild(li);
  });
  deleteBtn.disabled = !selectedSet.length;
}

// additive=true（Shift）时切换多选；否则单选。主对象始终是集合第一个。
function selectObject(obj, additive = false) {
  if (!obj) {
    selectedSet.length = 0;
  } else if (additive) {
    const idx = selectedSet.indexOf(obj);
    if (idx >= 0) selectedSet.splice(idx, 1);
    else selectedSet.push(obj);
  } else {
    selectedSet.length = 0;
    selectedSet.push(obj);
  }
  selected = selectedSet[0] || null;
  gizmo.setObjects(selectedSet);
  refreshSelectionHelpers();
  refreshSceneList();
  updateInspector();
}

// ---------- 检查器（只读，展示实际位置与约束轴） ----------
const inspectorEl = document.getElementById('inspector');
const f = (n) => Number(n).toFixed(3);

function updateInspector() {
  if (!selectedSet.length) {
    inspectorEl.innerHTML = '<p class="muted">未选中设备</p>';
    return;
  }
  const obj = selected;
  const wp = obj.getWorldPosition(new THREE.Vector3());
  const wq = obj.getWorldQuaternion(new THREE.Quaternion());
  const e = new THREE.Euler().setFromQuaternion(wq, 'YXZ');
  const deg = (r) => `${(r * 180 / Math.PI).toFixed(1)}°`;
  const modeText = { translate: '移动', rotate: '旋转', scale: '缩放' }[gizmo.mode];
  const activeAxis = gizmo.dragging && gizmo.drag?.handle
    ? describeHandle(gizmo.drag.handle)
    : '未拖拽（悬停/按下轴或平面）';
  const multiNote = selectedSet.length > 1
    ? `<tr><td>多选</td><td>共 ${selectedSet.length} 台，统一世界意图、各自父逆换算</td></tr>`
    : '';

  inspectorEl.innerHTML = `
    <table>
      <tr><td>设备</td><td>${obj.userData.label}${selectedSet.length > 1 ? `（主，+${selectedSet.length - 1}）` : ''}</td></tr>
      ${multiNote}
      <tr><td>模式</td><td>${modeText} / ${gizmo.space === 'world' ? '世界空间' : '局部空间'}</td></tr>
      <tr><td>世界位置 (m)</td><td>(${f(wp.x)}, ${f(wp.y)}, ${f(wp.z)})</td></tr>
      <tr><td>局部位置 (m)</td><td>(${f(obj.position.x)}, ${f(obj.position.y)}, ${f(obj.position.z)})</td></tr>
      <tr><td>世界姿态 (YXZ)</td><td>${deg(e.x)} / ${deg(e.y)} / ${deg(e.z)}</td></tr>
      <tr><td>局部缩放</td><td>(${f(obj.scale.x)}, ${f(obj.scale.y)}, ${f(obj.scale.z)})</td></tr>
      <tr><td>四元数</td><td>(${f(wq.x)}, ${f(wq.y)}, ${f(wq.z)}, ${f(wq.w)})</td></tr>
      <tr><td>当前约束</td><td>${activeAxis}</td></tr>
    </table>`;
}

function describeHandle(h) {
  const axisName = { x: 'X（红）', y: 'Y（绿）', z: 'Z（蓝）' }[h.axis] || '';
  const kind = {
    axis: '单轴',
    plane: '双轴平面',
    ring: '绕轴旋转环',
    scaleAxis: '单轴非均匀缩放',
    scaleCenter: '等比缩放'
  }[h.kind];
  return `${kind} ${axisName}`.trim();
}

// ---------- 指针交互 ----------
let pointerDown = null;

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  const { ray } = rayFromPointer(camera, canvas, ev.clientX, ev.clientY);
  gizmo.update();
  const handle = selectedSet.length ? gizmo.pick(ray) : null;

  if (handle) {
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    gizmo.beginDrag(handle, ray);
    pointerDown = { id: ev.pointerId, draggingGizmo: true };
    orbit.enabled = false;
    setStatus(`拖拽中：${describeHandle(handle)}（Esc 取消并恢复，Ctrl+Z 撤销）`);
    updateInspector();
  } else {
    pointerDown = { id: ev.pointerId, draggingGizmo: false, x: ev.clientX, y: ev.clientY, shift: ev.shiftKey };
  }
});

canvas.addEventListener('pointermove', (ev) => {
  const { ray } = rayFromPointer(camera, canvas, ev.clientX, ev.clientY);
  if (pointerDown?.draggingGizmo) {
    gizmo.updateDrag(ray);
    updateInspector();
    return;
  }
  if (!gizmo.dragging) {
    gizmo.update();
    const handle = selectedSet.length ? gizmo.pick(ray) : null;
    canvas.style.cursor = handle ? 'crosshair' : 'default';
  }
});

function finishPointer(ev) {
  if (!pointerDown) return;
  if (pointerDown.draggingGizmo) {
    const commit = gizmo.endDrag();
    orbit.enabled = true;
    pushUndo(commit);
    scheduleAutosave();
  } else {
    // 单击空白/设备：做场景拾取选择（Shift 追加多选）
    const moved = Math.hypot(ev.clientX - pointerDown.x, ev.clientY - pointerDown.y);
    if (moved < 5) {
      const { ray: clickRay } = rayFromPointer(camera, canvas, ev.clientX, ev.clientY);
      const rc = new THREE.Raycaster();
      rc.set(clickRay.origin, clickRay.direction);
      const hits = rc.intersectObjects(equipmentRoot.children, true);
      if (hits.length) {
        let root = hits[0].object;
        while (root && !root.userData?.isEquipment) root = root.parent;
        if (root) selectObject(root, pointerDown.shift || ev.shiftKey);
      } else if (!ev.shiftKey) {
        selectObject(null);
      }
    }
  }
  pointerDown = null;
}
canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', () => {
  if (pointerDown?.draggingGizmo) {
    // 取消拖动：内核逐对象恢复 beginDrag 快照，不入撤销栈、不清空父变换
    gizmo.cancelDrag();
    setStatus('已取消拖动，设备恢复到拖动前姿态');
  }
  pointerDown = null;
  orbit.enabled = true;
  updateInspector();
});

// ---------- 工具栏 ----------
const modeButtons = {
  translate: document.getElementById('mode-translate'),
  rotate: document.getElementById('mode-rotate'),
  scale: document.getElementById('mode-scale')
};
function setMode(mode) {
  gizmo.setMode(mode);
  for (const [m, btn] of Object.entries(modeButtons)) btn.classList.toggle('active', m === mode);
  updateInspector();
}
modeButtons.translate.addEventListener('click', () => setMode('translate'));
modeButtons.rotate.addEventListener('click', () => setMode('rotate'));
modeButtons.scale.addEventListener('click', () => setMode('scale'));

const spaceBtn = document.getElementById('space-toggle');
function toggleSpace() {
  gizmo.setSpace(gizmo.space === 'world' ? 'local' : 'world');
  spaceBtn.textContent = `空间：${gizmo.space === 'world' ? '世界 (Q)' : '局部 (Q)'}`;
  setStatus(`已切换到${gizmo.space === 'world' ? '世界' : '局部'}坐标模式`);
  updateInspector();
}
spaceBtn.addEventListener('click', toggleSpace);

const camBtn = document.getElementById('cam-toggle');
function toggleProjection() {
  const nextType = camera.isPerspectiveCamera ? 'orthographic' : 'perspective';
  const newCam = swapCameraProjection(camera, nextType);
  camera = newCam;
  if (newCam.isOrthographicCamera) orthoCam = newCam;
  else perspectiveCam = newCam;
  orbit.object = newCam;
  orbit.update();
  gizmo.camera = newCam;
  camBtn.textContent = `投影：${newCam.isPerspectiveCamera ? '透视 (P)' : '正交 (P)'}`;
  setStatus(newCam.isPerspectiveCamera ? '已切换为透视投影' : '已切换为正交投影');
}
camBtn.addEventListener('click', toggleProjection);

window.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  const key = ev.key.toLowerCase();
  if (key === 'z' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    undoLast();
  } else if (key === 'escape' && gizmo.dragging) {
    // Esc 取消当前拖动：恢复 beginDrag 快照，不入撤销栈
    gizmo.cancelDrag();
    orbit.enabled = true;
    pointerDown = null;
    updateInspector();
    setStatus('已取消拖动，设备恢复到拖动前姿态');
  } else if (key === 'w') setMode('translate');
  else if (key === 'e') setMode('rotate');
  else if (key === 'r') setMode('scale');
  else if (key === 'q') toggleSpace();
  else if (key === 'p') toggleProjection();
  else if (key === 'delete' || key === 'backspace') {
    if (selectedSet.length) deleteSelected();
  }
});

function deleteSelected() {
  if (!selectedSet.length) return;
  for (const obj of [...selectedSet]) equipmentRoot.remove(obj);
  selectObject(null);
  refreshSceneList();
  scheduleAutosave();
  setStatus('已删除选中设备');
}
deleteBtn.addEventListener('click', deleteSelected);

// ---------- 保存 / 加载 ----------
function currentLayout() {
  return serializeLayout(equipmentRoot);
}
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      saveToLocalStorage(currentLayout());
      setStatus('布局已自动保存到浏览器本地');
    } catch {
      setStatus('自动保存失败（浏览器存储不可用）');
    }
  }, 500);
}

document.getElementById('save-btn').addEventListener('click', () => {
  saveToLocalStorage(currentLayout());
  setStatus('布局已保存到浏览器本地存储');
});
document.getElementById('export-btn').addEventListener('click', () => {
  downloadLayout(currentLayout());
  setStatus('布局 JSON 已导出下载');
});
document.getElementById('load-btn').addEventListener('click', () => {
  document.getElementById('load-file').click();
});
document.getElementById('load-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = validateLayout(JSON.parse(text));
    applyLayout(equipmentRoot, data, (type) => createEquipment(type));
    selectObject(null);
    refreshSceneList();
    scheduleAutosave();
    setStatus(`已加载布局：${data.items.length} 台设备`);
  } catch (err) {
    setStatus(`加载失败：${err.message}`);
  } finally {
    ev.target.value = '';
  }
});

// 启动时恢复上次布局
(function restore() {
  const data = loadFromLocalStorage();
  if (data?.items?.length) {
    applyLayout(equipmentRoot, data, (type) => createEquipment(type));
    refreshSceneList();
    setStatus(`已恢复上次布局：${data.items.length} 台设备`);
  }
})();

// ---------- 渲染循环 ----------
function onResize() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  aspect = w / h;
  resizeCameras([perspectiveCam, orthoCam].filter(Boolean), aspect);
}
window.addEventListener('resize', onResize);
onResize();

function tick() {
  requestAnimationFrame(tick);
  orbit.update();
  gizmo.update();
  for (const helper of selectionHelpers) helper.update();
  updateInspectorThrottled();
  renderer.render(scene, camera);
}

let inspectorFrame = 0;
function updateInspectorThrottled() {
  if (++inspectorFrame % 6 === 0) updateInspector();
}
tick();

// 供测试/调试使用的合成射线入口
export { gizmo, equipmentRoot, rayFromNDC };
