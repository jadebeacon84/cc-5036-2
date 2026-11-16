import * as THREE from 'three';

// 自制实验设备：均为参数化几何体组合，底部落在局部原点 (y=0)，
// 局部尺度以“米”为单位。每台设备是一个独立 Group（旋转父节点），
// 变换操纵作用于该 Group，内部子网格只负责造型。

function box(w, h, d, color, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 })
  );
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cylinder(rTop, rBottom, h, color, x, y, z, radial = 24) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBottom, h, radial),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.25 })
  );
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function frame(group, w, d, h, color) {
  const leg = 0.05;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(box(leg, h, leg, color, (sx * (w - leg)) / 2, 0, (sz * (d - leg)) / 2));
    }
  }
}

const BUILDERS = {
  workbench: {
    label: '实验台',
    color: 0x8d6e63,
    build() {
      const g = new THREE.Group();
      frame(g, 1.8, 0.8, 0.85, 0x5d4037);
      g.add(box(1.9, 0.06, 0.9, 0xbcaaa4, 0, 0.85, 0)); // 台面
      return g;
    }
  },
  fumeHood: {
    label: '通风柜',
    color: 0x90a4ae,
    build() {
      const g = new THREE.Group();
      g.add(box(1.5, 0.9, 0.85, 0xcfd8dc, 0, 0, 0)); // 下柜
      g.add(box(1.5, 1.1, 0.85, 0xeceff1, 0, 0.9, 0)); // 上腔体（半透明视窗）
      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.8, 0.02),
        new THREE.MeshStandardMaterial({
          color: 0x81d4fa,
          transparent: true,
          opacity: 0.35,
          roughness: 0.1
        })
      );
      glass.position.set(0, 1.45, 0.43);
      g.add(glass);
      g.add(cylinder(0.12, 0.12, 0.5, 0x607d8b, 0, 2.0, 0)); // 排风管
      return g;
    }
  },
  cabinet: {
    label: '试剂柜',
    color: 0x7e57c2,
    build() {
      const g = new THREE.Group();
      g.add(box(1.0, 2.0, 0.5, 0xd1c4e9, 0, 0, 0));
      for (let i = 1; i < 4; i++) {
        g.add(box(0.94, 0.02, 0.52, 0x9575cd, 0, (i * 2.0) / 4, 0));
      }
      g.add(box(0.02, 1.9, 0.02, 0x4527a0, -0.02, 0.05, 0.26)); // 门缝/把手
      return g;
    }
  },
  sink: {
    label: '水槽台',
    color: 0x4db6ac,
    build() {
      const g = new THREE.Group();
      frame(g, 1.2, 0.7, 0.8, 0x455a64);
      g.add(box(1.3, 0.06, 0.8, 0x90a4ae, 0, 0.8, 0));
      const basin = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.25, 0.45),
        new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.3, metalness: 0.6 })
      );
      basin.position.set(0, 0.72, 0);
      g.add(basin);
      g.add(cylinder(0.02, 0.02, 0.35, 0xcfd8dc, 0.32, 0.84, 0));
      return g;
    }
  },
  analyzer: {
    label: '分析仪器箱',
    color: 0xffb74d,
    build() {
      const g = new THREE.Group();
      g.add(box(0.9, 0.55, 0.6, 0xffcc80, 0, 0, 0));
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.22, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x263238, emissive: 0x1b5e20, emissiveIntensity: 0.6 })
      );
      panel.position.set(0, 0.32, 0.31);
      g.add(panel);
      g.add(cylinder(0.03, 0.03, 0.15, 0x616161, -0.3, 0.55, -0.2));
      return g;
    }
  },
  gasCylinder: {
    label: '气瓶（立式）',
    color: 0xef5350,
    build() {
      const g = new THREE.Group();
      g.add(cylinder(0.14, 0.14, 1.4, 0xef9a9a, 0, 0, 0));
      g.add(cylinder(0.05, 0.05, 0.12, 0x424242, 0, 1.4, 0));
      g.add(cylinder(0.16, 0.16, 0.08, 0x37474f, 0, 0, 0)); // 底座
      return g;
    }
  }
};

export const EQUIPMENT_TYPES = Object.keys(BUILDERS);

export function equipmentLabel(type) {
  return BUILDERS[type]?.label ?? type;
}

let serial = 0;

export function createEquipment(type) {
  const def = BUILDERS[type];
  if (!def) throw new Error(`未知设备类型: ${type}`);
  const group = def.build();
  group.name = `${type}-${++serial}`;
  group.userData.isEquipment = true;
  group.userData.type = type;
  group.userData.label = def.label;
  group.userData.id = `eq-${Date.now().toString(36)}-${serial}`;
  return group;
}

// 选中高亮：整体外框
export function makeBoxHelper(object) {
  const helper = new THREE.BoxHelper(object, 0xffeb3b);
  helper.visible = false;
  return helper;
}
