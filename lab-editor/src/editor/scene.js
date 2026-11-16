import * as THREE from 'three';

// 由 NDC 坐标（含画布四角 ±1）构造拾取射线，统一透视/正交两种投影
export function rayFromNDC(camera, ndcX, ndcY) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  return { origin: raycaster.ray.origin.clone(), direction: raycaster.ray.direction.clone() };
}

export function rayFromPointer(camera, canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
  return { ndcX, ndcY, ray: rayFromNDC(camera, ndcX, ndcY) };
}

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101418);

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2f36, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(8, 14, 6);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.left = -20;
  dir.shadow.camera.right = 20;
  dir.shadow.camera.top = 20;
  dir.shadow.camera.bottom = -20;
  scene.add(dir);

  const grid = new THREE.GridHelper(40, 40, 0x4a5563, 0x2b333c);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.ShadowMaterial({ opacity: 0.35 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  return { scene, ground };
}

// 透视 -> 正交 / 正交 -> 透视时保持视线方向与目标点不变
export function swapCameraProjection(current, target) {
  const oldPos = current.position.clone();
  const oldDir = current.getWorldDirection(new THREE.Vector3());
  const dist = oldPos.length() || 10;

  if (target === 'orthographic') {
    const aspect = current.aspect;
    const viewHeight = 2 * dist * Math.tan((current.fov * Math.PI) / 360);
    const cam = new THREE.OrthographicCamera(
      (-viewHeight * aspect) / 2,
      (viewHeight * aspect) / 2,
      viewHeight / 2,
      -viewHeight / 2,
      0.1,
      500
    );
    cam.position.copy(oldPos);
    cam.lookAt(oldPos.clone().add(oldDir));
    cam.userData.perspDistance = dist;
    return cam;
  }
  const cam = new THREE.PerspectiveCamera(50, current.aspect, 0.1, 500);
  cam.position.copy(oldPos);
  cam.lookAt(oldPos.clone().add(oldDir));
  return cam;
}

export function resizeCameras(cameras, aspect) {
  for (const cam of cameras) {
    cam.aspect = aspect;
    if (cam.isOrthographicCamera) {
      const viewHeight = cam.top - cam.bottom;
      cam.left = (-viewHeight * aspect) / 2;
      cam.right = (viewHeight * aspect) / 2;
    }
    cam.updateProjectionMatrix();
  }
}
