// 布局保存/加载：只持久化设备类型与局部变换（位置、欧拉角、三轴缩放），
// 不保存相机等视图状态之外的渲染临时对象。几何可摆放性不代表安装安全结论。

const STORAGE_KEY = 'lab-editor-layout-v1';

function round(v, digits = 5) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function serializeLayout(equipmentRoot) {
  const items = [];
  equipmentRoot.children.forEach((obj) => {
    if (!obj.userData?.isEquipment) return;
    items.push({
      id: obj.userData.id,
      type: obj.userData.type,
      label: obj.userData.label,
      position: [round(obj.position.x), round(obj.position.y), round(obj.position.z)],
      rotation: [round(obj.rotation.x), round(obj.rotation.y), round(obj.rotation.z)],
      scale: [round(obj.scale.x), round(obj.scale.y), round(obj.scale.z)]
    });
  });
  return {
    format: 'lab-layout',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: '几何布局数据，不构成设备安装安全结论',
    items
  };
}

export function validateLayout(data) {
  if (!data || data.format !== 'lab-layout' || !Array.isArray(data.items)) {
    throw new Error('布局文件格式无法识别');
  }
  for (const it of data.items) {
    if (!it.type || !Array.isArray(it.position) || it.position.length !== 3) {
      throw new Error('布局数据包含无效条目');
    }
  }
  return data;
}

export function applyLayout(equipmentRoot, data, factory) {
  validateLayout(data);
  while (equipmentRoot.children.length) {
    equipmentRoot.remove(equipmentRoot.children[0]);
  }
  const restored = [];
  for (const item of data.items) {
    const obj = factory(item.type);
    obj.userData.id = item.id || obj.userData.id;
    obj.position.set(...item.position);
    if (Array.isArray(item.rotation) && item.rotation.length === 3) {
      obj.rotation.set(...item.rotation);
    }
    if (Array.isArray(item.scale) && item.scale.length === 3) {
      obj.scale.set(...item.scale);
    }
    equipmentRoot.add(obj);
    restored.push(obj);
  }
  return restored;
}

export function saveToLocalStorage(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function loadFromLocalStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return validateLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function downloadLayout(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lab-layout-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
