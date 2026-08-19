import * as THREE from 'https://esm.sh/three@0.180.0';
import { OrbitControls } from 'https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
import { ColladaLoader } from 'https://esm.sh/three@0.180.0/examples/jsm/loaders/ColladaLoader.js';
import { GLTFExporter } from 'https://esm.sh/three@0.180.0/examples/jsm/exporters/GLTFExporter.js';

const screens = ['license', 'import', 'viewer'];
const $ = selector => document.querySelector(selector);
let objectUrl, renderer, scene, camera, controls, model, gridHelper;
let currentFiles = [];
let navigatorDragging = false;
let cameraMoveToken = 0;
let frontOffset = Number(localStorage.getItem('m3d-front-offset') || 0);
let darkBackground = true;
let measureMode = false;
let measurePoints = [];
let measurementObjects = [];
let selectionMode = true;
let selectedObject = null;
let selectionHelper = null;
let sourceUnit = 'm';
let sectionPlane = null;
const originalMeshState = new Map();
const objectNotes = new Map();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let originalModelCenter = new THREE.Vector3();
let originalModelSize = new THREE.Vector3();
let technicalMetadata = null;
let needsRender = true;
const mobileDevice = matchMedia('(max-width: 700px), (pointer: coarse)').matches;

function requestRender() {
  needsRender = true;
}

function show(name) {
  screens.forEach(item => {
    $(`#${item}-screen`).classList.toggle('active', item === name);
    document.querySelector(`[data-step="${item}"]`).classList.toggle('active', item === name);
  });
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'No se pudo completar la solicitud.');
  return data;
}

function initializeViewer() {
  if (renderer) return;
  const stage = $('#viewer-stage');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111417);
  camera = new THREE.PerspectiveCamera(45, stage.clientWidth / stage.clientHeight, 0.01, 100000);
  camera.position.set(6, 4, 7);
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const normalPixelRatio = Math.min(devicePixelRatio, mobileDevice ? 1.25 : 1.75);
  renderer.setPixelRatio(normalPixelRatio);
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !mobileDevice;
  $('#shadow-toggle')?.classList.toggle('active', renderer.shadowMap.enabled);
  stage.prepend(renderer.domElement);
  renderer.domElement.addEventListener('pointerdown', handleCanvasClick);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.addEventListener('change', () => { updateNavigator(); requestRender(); });
  controls.addEventListener('start', () => { renderer.setPixelRatio(1); requestRender(); });
  controls.addEventListener('end', () => { renderer.setPixelRatio(normalPixelRatio); requestRender(); });
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.5));
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(8, 12, 6);
  gridHelper = new THREE.GridHelper(40, 40, 0x52606d, 0x2a323a);
  scene.add(sun, gridHelper);
  new ResizeObserver(() => {
    const aspect = stage.clientWidth / stage.clientHeight;
    if (camera.isPerspectiveCamera) camera.aspect = aspect;
    if (camera.isOrthographicCamera) {
      const half = (camera.top - camera.bottom) / 2;
      camera.left = -half * aspect;
      camera.right = half * aspect;
    }
    camera.updateProjectionMatrix();
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
    requestRender();
  }).observe(stage);
  renderer.setAnimationLoop(() => {
    if (document.hidden) return;
    const controlsChanged = controls.update();
    if (!controlsChanged && !needsRender) return;
    renderer.render(scene, camera);
    needsRender = false;
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function modelMeshes() {
  const meshes = [];
  model?.traverse(item => { if (item.isMesh) meshes.push(item); });
  return meshes;
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, ' ');
}

async function readMetadataFile(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(await file.text());
    return data?.schema === 'modular-3d-view-metadata' && Array.isArray(data.pieces) ? data : null;
  } catch {
    return null;
  }
}

function applyTechnicalMetadata() {
  const pieces = Array.isArray(technicalMetadata?.pieces) ? technicalMetadata.pieces : [];
  if (!pieces.length) return;
  const queues = new Map();
  pieces.forEach(piece => {
    [piece.name, piece.definition, piece.path?.[piece.path.length - 1]].filter(Boolean).forEach(value => {
      const key = normalizedName(value);
      if (!queues.has(key)) queues.set(key, []);
      if (!queues.get(key).includes(piece)) queues.get(key).push(piece);
    });
  });
  modelMeshes().forEach(mesh => {
    const names = [mesh.name, mesh.parent?.name, mesh.parent?.parent?.name].map(normalizedName).filter(Boolean);
    const piece = names.map(name => queues.get(name)?.[0]).find(Boolean);
    if (!piece) return;
    mesh.userData.m3dMeta = piece;
    mesh.userData.m3dId = piece.id;
    mesh.userData.m3dName = piece.name;
  });
}

function rememberModelState() {
  originalMeshState.clear();
  const modelBox = new THREE.Box3().setFromObject(model);
  originalModelCenter = modelBox.getCenter(new THREE.Vector3());
  originalModelSize = modelBox.getSize(new THREE.Vector3());
  applyTechnicalMetadata();
  modelMeshes().forEach((mesh, index) => {
    mesh.userData.m3dId = mesh.userData.m3dId || `mesh-${index}`;
    mesh.userData.m3dName = mesh.name || mesh.parent?.name || `Componente ${index + 1}`;
    originalMeshState.set(mesh, {
      position: mesh.position.clone(),
      worldCenter: new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()),
      visible: mesh.visible,
      materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => ({ material, opacity: material.opacity, transparent: material.transparent, clippingPlanes: material.clippingPlanes }))
    });
  });
  buildComponentTree();
  updateModelHealth();
}

function updateModelHealth() {
  if (!model) return;
  let triangles = 0;
  const materials = new Set();
  const textures = new Set();
  const meshes = modelMeshes();
  meshes.forEach(mesh => {
    const geometry = mesh.geometry;
    triangles += geometry?.index ? geometry.index.count / 3 : (geometry?.attributes?.position?.count || 0) / 3;
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean).forEach(material => {
      materials.add(material.uuid);
      if (material.map) textures.add(material.map.uuid);
    });
  });
  const weight = currentFiles.reduce((total, file) => total + Number(file.size || 0), 0);
  const heavy = triangles > 1_000_000 || textures.size > 30 || weight > 100 * 1024 * 1024;
  const medium = triangles > 300_000 || textures.size > 15 || weight > 40 * 1024 * 1024;
  const level = heavy ? 'Pesado' : medium ? 'Medio' : 'Ligero';
  const health = $('#model-health');
  health.dataset.level = level.toLowerCase();
  health.innerHTML = `<span>${level} · ${meshes.length} piezas</span><strong>${Math.round(triangles).toLocaleString('es-EC')} triángulos · ${textures.size} texturas</strong>`;
  if (heavy && renderer.shadowMap.enabled) {
    renderer.shadowMap.enabled = false;
    $('#shadow-toggle').classList.remove('active');
  }
}

function assessModelForPublishing() {
  const meshes = modelMeshes();
  if (!meshes.length) return { blocked: true, message: 'El modelo no contiene piezas publicables.' };
  let triangles = 0;
  let missingMaterials = 0;
  meshes.forEach(mesh => {
    triangles += mesh.geometry?.index ? mesh.geometry.index.count / 3 : (mesh.geometry?.attributes?.position?.count || 0) / 3;
    if (!mesh.userData.m3dMeta?.material && !String((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name || '').trim()) missingMaterials += 1;
  });
  const warnings = [];
  if (!technicalMetadata) warnings.push('no contiene metadatos técnicos del RBZ Pro');
  if (missingMaterials) warnings.push(`${missingMaterials} piezas no tienen material identificado`);
  if (triangles > 1_000_000) warnings.push('el modelo supera un millón de triángulos y puede tardar en celulares');
  return { blocked: false, warnings, message: warnings.join('; ') };
}

function displayLength(modelUnits) {
  const meters = Number(modelUnits || 0) * (sourceUnit === 'mm' ? .001 : sourceUnit === 'cm' ? .01 : 1);
  const unit = $('#measure-unit')?.value || 'mm';
  const value = unit === 'mm' ? meters * 1000 : unit === 'cm' ? meters * 100 : meters;
  return `${value.toFixed(unit === 'm' ? 3 : unit === 'cm' ? 1 : 0)} ${unit}`;
}

function displayMillimeters(millimeters) {
  const unit = $('#measure-unit')?.value || 'mm';
  const value = unit === 'm' ? Number(millimeters || 0) / 1000 : unit === 'cm' ? Number(millimeters || 0) / 10 : Number(millimeters || 0);
  return `${value.toFixed(unit === 'm' ? 3 : unit === 'cm' ? 1 : 0)} ${unit}`;
}

function materialDescription(mesh) {
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter(Boolean);
  const names = [...new Set(materials.map(material => {
    const name = String(material.name || '').trim();
    if (name) return name;
    if (material.map?.name) return material.map.name;
    if (material.color) return `Color #${material.color.getHexString().toUpperCase()}`;
    return 'Sin nombre';
  }))];
  return names.join(' / ') || 'No identificado';
}

function updatePieceProperties(mesh) {
  const panel = $('#piece-properties');
  if (!mesh) {
    panel.hidden = true;
    return;
  }
  const metadata = mesh.userData.m3dMeta;
  const dimensions = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).toArray().sort((a, b) => b - a);
  $('#piece-length').textContent = metadata ? displayMillimeters(metadata.length_mm) : displayLength(dimensions[0]);
  $('#piece-width').textContent = metadata ? displayMillimeters(metadata.width_mm) : displayLength(dimensions[1]);
  $('#piece-thickness').textContent = metadata ? displayMillimeters(metadata.thickness_mm) : displayLength(dimensions[2]);
  $('#piece-material').textContent = metadata?.material || materialDescription(mesh);
  panel.hidden = false;
}

function updateModuleDimensions() {
  if (!model) return;
  const project = technicalMetadata?.project;
  if (project?.width_mm != null) {
    $('#module-width').textContent = displayMillimeters(project.width_mm);
    $('#module-height').textContent = displayMillimeters(project.height_mm);
    $('#module-depth').textContent = displayMillimeters(project.depth_mm);
    return;
  }
  const size = originalModelSize.lengthSq() ? originalModelSize : new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  $('#module-width').textContent = displayLength(size.x);
  $('#module-height').textContent = displayLength(size.y);
  $('#module-depth').textContent = displayLength(size.z);
}

function buildComponentTree(filter = '') {
  const tree = $('#component-tree');
  if (!tree) return;
  const term = filter.trim().toLowerCase();
  const unique = new Map();
  modelMeshes().forEach(mesh => { if (!unique.has(mesh.userData.m3dId)) unique.set(mesh.userData.m3dId, mesh); });
  const meshes = [...unique.values()].filter(mesh => {
    const searchable = [mesh.userData.m3dName, ...(mesh.userData.m3dMeta?.path || []), mesh.userData.m3dMeta?.material].join(' ').toLowerCase();
    return !term || searchable.includes(term);
  });
  tree.innerHTML = meshes.length ? meshes.map(mesh => {
    const path = mesh.userData.m3dMeta?.path;
    const label = path?.length > 1 ? path.slice(-2).join(' › ') : mesh.userData.m3dName;
    return `<button data-mesh-id="${escapeHtml(mesh.userData.m3dId)}" class="${mesh.userData.m3dId === selectedObject?.userData.m3dId ? 'active' : ''}"><span>${mesh.visible ? '◈' : '◇'}</span>${escapeHtml(label)}</button>`;
  }).join('') : '<p class="muted">Sin coincidencias</p>';
}

function selectObject(object) {
  if (selectionHelper) scene.remove(selectionHelper);
  selectedObject = object?.isMesh ? object : null;
  if (selectedObject) {
    selectionHelper = new THREE.BoxHelper(selectedObject, 0xff6b1a);
    selectionHelper.material.depthTest = false;
    selectionHelper.renderOrder = 999;
    scene.add(selectionHelper);
    $('#selection-summary').textContent = selectedObject.userData.m3dName;
    $('#object-note').value = objectNotes.get(selectedObject.userData.m3dId) || '';
    const material = Array.isArray(selectedObject.material) ? selectedObject.material[0] : selectedObject.material;
    $('#opacity-range').value = Math.round((material?.opacity ?? 1) * 100);
    $('#opacity-output').value = `${$('#opacity-range').value}%`;
    updatePieceProperties(selectedObject);
  } else {
    selectionHelper = null;
    $('#selection-summary').textContent = 'Ningún objeto seleccionado';
    $('#object-note').value = '';
    updatePieceProperties(null);
  }
  buildComponentTree($('#model-search')?.value || '');
  requestRender();
}

function pointerHit(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(modelMeshes().filter(mesh => mesh.visible), false)[0] || null;
}

function handleCanvasClick(event) {
  if (!model) return;
  if (measureMode) return handleMeasurementClick(event);
  if (!selectionMode) return;
  selectObject(pointerHit(event)?.object || null);
}

function frameModel() {
  if (!model) return;
  switchProjection('perspective');
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z, 1) * 1.8;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.65, -distance));
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function modelCenter() {
  return model ? new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()) : controls.target.clone();
}

function modelMaximumSize() {
  if (!model) return 10;
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 1);
}

function switchProjection(mode) {
  if (!camera || !controls) return;
  if ((mode === 'orthographic' && camera.isOrthographicCamera) || (mode === 'perspective' && camera.isPerspectiveCamera)) return;
  const stage = $('#viewer-stage');
  const aspect = stage.clientWidth / stage.clientHeight;
  const position = camera.position.clone();
  const up = camera.up.clone();
  const distance = Math.max(position.distanceTo(controls.target), 1);
  if (mode === 'orthographic') {
    const half = modelMaximumSize() * .62;
    camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, Math.max(distance / 1000, .01), distance * 100);
  } else {
    camera = new THREE.PerspectiveCamera(45, aspect, Math.max(distance / 1000, .01), distance * 100);
  }
  camera.position.copy(position);
  camera.up.copy(up);
  camera.lookAt(controls.target);
  controls.object = camera;
  controls.update();
  $('#projection-toggle').textContent = camera.isOrthographicCamera ? 'Ortogonal' : 'Perspectiva';
  $('#projection-toggle').classList.toggle('active', camera.isOrthographicCamera);
}

function fitOrthographicToModel(margin = 1.12) {
  if (!model || !camera?.isOrthographicCamera) return;
  const box = new THREE.Box3().setFromObject(model);
  const points = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
  const minX = Math.min(...points.map(point => point.x));
  const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const width = Math.max((maxX - minX) * margin, .01);
  const height = Math.max((maxY - minY) * margin, .01);
  const aspect = $('#viewer-stage').clientWidth / $('#viewer-stage').clientHeight;
  const viewHeight = Math.max(height, width / aspect);
  camera.left = -viewHeight * aspect / 2;
  camera.right = viewHeight * aspect / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
}

function calibratedDirection(direction) {
  return direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), frontOffset);
}

function clearMeasurement() {
  measurementObjects.forEach(object => scene.remove(object));
  measurementObjects = [];
  measurePoints = [];
  requestRender();
}

function handleMeasurementClick(event) {
  if (!measureMode || !model) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(model, true)[0];
  if (!hit) return;
  if (measurePoints.length === 2) clearMeasurement();
  measurePoints.push(hit.point.clone());
  const radius = modelMaximumSize() * .012;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff6b1a }));
  marker.position.copy(hit.point);
  scene.add(marker);
  measurementObjects.push(marker);
  if (measurePoints.length === 2) {
    const geometry = new THREE.BufferGeometry().setFromPoints(measurePoints);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xff6b1a }));
    scene.add(line);
    measurementObjects.push(line);
    const meters = measurePoints[0].distanceTo(measurePoints[1]) * (sourceUnit === 'mm' ? .001 : sourceUnit === 'cm' ? .01 : 1);
    const unit = $('#measure-unit').value;
    const value = unit === 'mm' ? meters * 1000 : unit === 'cm' ? meters * 100 : meters;
    $('#viewer-message').textContent = `Distancia: ${value.toFixed(unit === 'm' ? 3 : 1)} ${unit}`;
  } else $('#viewer-message').textContent = 'Selecciona el segundo punto de medición.';
  requestRender();
}

function moveCameraTo(direction, duration = 360) {
  if (!camera || !controls) return;
  const axisCount = [direction.x, direction.y, direction.z].filter(value => Math.abs(value) > .001).length;
  switchProjection(axisCount === 1 ? 'orthographic' : 'perspective');
  const moveToken = ++cameraMoveToken;
  const target = modelCenter();
  const distance = Math.max(camera.position.distanceTo(controls.target), 1);
  const end = target.clone().add(direction.clone().normalize().multiplyScalar(distance));
  if (duration <= 0) {
    camera.position.copy(end);
    controls.target.copy(target);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    controls.update();
    fitOrthographicToModel();
    return;
  }
  const start = camera.position.clone();
  const startTarget = controls.target.clone();
  const began = performance.now();
  const animateMove = now => {
    if (moveToken !== cameraMoveToken) return;
    const progress = Math.min((now - began) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    camera.position.lerpVectors(start, end, eased);
    controls.target.lerpVectors(startTarget, target, eased);
    camera.up.set(0, 1, 0);
    camera.lookAt(controls.target);
    controls.update();
    if (progress < 1) requestAnimationFrame(animateMove);
    else fitOrthographicToModel();
  };
  requestAnimationFrame(animateMove);
}

function currentViewDirection() {
  return camera.position.clone().sub(controls.target).normalize();
}

function orbitStep(action, angle = Math.PI / 4, duration = 360) {
  const direction = currentViewDirection();
  if (action === 'left' || action === 'right') {
    direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), action === 'left' ? -angle : angle);
  } else {
    const spherical = new THREE.Spherical().setFromVector3(direction);
    spherical.phi = THREE.MathUtils.clamp(spherical.phi + (action === 'up' ? -angle : angle), .08, Math.PI - .08);
    direction.setFromSpherical(spherical);
  }
  moveCameraTo(direction, duration);
}

function updateNavigator() {
  if (!camera || !controls) return;
  const direction = currentViewDirection();
  const displayDirection = direction.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -frontOffset);
  const yaw = THREE.MathUtils.radToDeg(Math.atan2(displayDirection.x, displayDirection.z));
  const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(displayDirection.y, -1, 1)));
  $('#nav-cube').style.transform = `rotateX(${pitch}deg) rotateY(${-yaw}deg)`;
  document.querySelectorAll('.nav-cube-face [data-view]').forEach(button => {
    const candidate = calibratedDirection(new THREE.Vector3(...button.dataset.view.split(',').map(Number))).normalize();
    button.classList.toggle('active', candidate.dot(direction) > .995);
  });
}

function initializeNavigator() {
  const navigator = $('#view-navigator');
  const cube = $('#nav-cube');
  const faces = [
    { name: 'front', label: 'FRENTE', normal: [0, 0, -1], horizontal: [-1, 0, 0], vertical: [0, 1, 0] },
    { name: 'back', label: 'ATRÁS', normal: [0, 0, 1], horizontal: [1, 0, 0], vertical: [0, 1, 0] },
    { name: 'right', label: 'DERECHA', normal: [1, 0, 0], horizontal: [0, 0, -1], vertical: [0, 1, 0] },
    { name: 'left', label: 'IZQUIERDA', normal: [-1, 0, 0], horizontal: [0, 0, 1], vertical: [0, 1, 0] },
    { name: 'top', label: 'ARRIBA', normal: [0, 1, 0], horizontal: [1, 0, 0], vertical: [0, 0, 1] },
    { name: 'bottom', label: 'ABAJO', normal: [0, -1, 0], horizontal: [1, 0, 0], vertical: [0, 0, -1] }
  ];
  const rows = [1, 0, -1];
  const columns = [-1, 0, 1];
  faces.forEach(face => {
    const element = document.createElement('div');
    element.className = `nav-cube-face cube-${face.name}`;
    rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
      const direction = new THREE.Vector3(...face.normal)
        .addScaledVector(new THREE.Vector3(...face.horizontal), column)
        .addScaledVector(new THREE.Vector3(...face.vertical), row);
      const button = document.createElement('button');
      button.dataset.view = direction.toArray().join(',');
      button.dataset.group = direction.toArray().map(value => Math.sign(value)).join(',');
      button.title = row === 0 && column === 0 ? `Vista ${face.label.toLowerCase()}` : `Vista diagonal desde ${face.label.toLowerCase()}`;
      if (rowIndex === 1 && columnIndex === 1) {
        button.className = 'nav-center';
        button.textContent = face.label;
      }
      element.appendChild(button);
    }));
    cube.appendChild(element);
  });
  navigator.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('pointerenter', () => {
      navigator.querySelectorAll(`[data-group="${button.dataset.group}"]`).forEach(item => item.classList.add('linked'));
    });
    button.addEventListener('pointerleave', () => {
      navigator.querySelectorAll(`[data-group="${button.dataset.group}"]`).forEach(item => item.classList.remove('linked'));
    });
    button.addEventListener('click', event => {
      if (navigatorDragging) return;
      const [x, y, z] = event.currentTarget.dataset.view.split(',').map(Number);
      moveCameraTo(calibratedDirection(new THREE.Vector3(x, y, z)));
    });
  });
  navigator.querySelectorAll('[data-orbit]').forEach(button => button.addEventListener('click', () => orbitStep(button.dataset.orbit)));
  $('#nav-home').addEventListener('click', () => moveCameraTo(calibratedDirection(new THREE.Vector3(1, .65, -1))));
  const face = $('#nav-face');
  let previous = null;
  face.addEventListener('pointerdown', event => {
    navigatorDragging = false;
    previous = { x: event.clientX, y: event.clientY };
  });
  face.addEventListener('pointermove', event => {
    if (!previous) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2 && !navigatorDragging) {
      navigatorDragging = true;
      face.setPointerCapture(event.pointerId);
    }
    if (navigatorDragging) {
      if (Math.abs(dx) >= 1) orbitStep(dx > 0 ? 'right' : 'left', Math.abs(dx) * .008, 0);
      if (Math.abs(dy) >= 1) orbitStep(dy > 0 ? 'down' : 'up', Math.abs(dy) * .008, 0);
      previous = { x: event.clientX, y: event.clientY };
    }
  });
  const endDrag = () => { previous = null; setTimeout(() => { navigatorDragging = false; }, 0); };
  face.addEventListener('pointerup', endDrag);
  face.addEventListener('pointercancel', endDrag);
}

async function openFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['glb', 'gltf'].includes(extension)) throw new Error('Selecciona un archivo .GLB o .GLTF.');
  if (file.size > 250 * 1024 * 1024) throw new Error('El modelo supera el límite local de 250 MB.');
  show('viewer');
  initializeViewer();
  if (model) scene.remove(model);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  $('#viewer-title').textContent = file.name.replace(/\.(glb|gltf)$/i, '');
  $('#viewer-message').textContent = 'Cargando geometría y materiales…';
  const gltf = await new GLTFLoader().loadAsync(objectUrl);
  model = gltf.scene;
  technicalMetadata = null;
  currentFiles = [file];
  sourceUnit = 'm';
  model.traverse(item => {
    if (item.isMesh) { item.castShadow = true; item.receiveShadow = true; }
  });
  scene.add(model);
  rememberModelState();
  frameModel();
  $('#viewer-message').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
}

async function openSketchUpExport(fileList) {
  const files = Array.from(fileList);
  currentFiles = files;
  const dae = files.find(file => file.name.toLowerCase().endsWith('.dae'));
  if (!dae) throw new Error('La carpeta no contiene el archivo .DAE exportado por SketchUp.');
  show('viewer');
  initializeViewer();
  if (model) scene.remove(model);
  const urls = new Map();
  files.forEach(file => {
    const url = URL.createObjectURL(file);
    urls.set(file.name.toLowerCase(), url);
    urls.set((file.webkitRelativePath || file.name).toLowerCase(), url);
  });
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    const clean = decodeURIComponent(url).replace(/^\.\//, '').toLowerCase();
    const name = clean.split('/').pop();
    return urls.get(clean) || urls.get(name) || url;
  });
  $('#viewer-title').textContent = dae.name.replace(/\.dae$/i, '');
  $('#viewer-message').textContent = 'Cargando exportación de SketchUp…';
  const metadataFile = files.find(file => file.name.toLowerCase().endsWith('.metadata.json'));
  technicalMetadata = await readMetadataFile(metadataFile);
  const text = await dae.text();
  const collada = new ColladaLoader(manager).parse(text, '');
  model = collada.scene;
  sourceUnit = 'm';
  model.traverse(item => {
    if (item.isMesh) { item.castShadow = true; item.receiveShadow = true; }
  });
  scene.add(model);
  rememberModelState();
  frameModel();
  $('#viewer-message').textContent = `${dae.name} · exportado desde SketchUp`;
}

async function loadSharedModel() {
  const match = location.pathname.match(/^\/view\/([^/]+)$/);
  if (!match) return false;
  const token = new URLSearchParams(location.search).get('token');
  if (!token) throw new Error('El enlace del proyecto está incompleto.');
  show('viewer');
  initializeViewer();
  $('#publish-mobile').hidden = true;
  $('#share-expiry').hidden = true;
  $('#share-permission').hidden = true;
  $('#share-password').hidden = true;
  $('#back-import').hidden = true;
  $('#viewer-message').textContent = 'Descargando proyecto compartido…';
  let manifestResponse = await fetch(`/api/shared/${match[1]}/manifest?token=${encodeURIComponent(token)}`);
  if (manifestResponse.status === 401) {
    const password = prompt('Este proyecto está protegido. Ingresa la contraseña:') || '';
    const unlock = await fetch(`/api/shared/${match[1]}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
    if (!unlock.ok) throw new Error((await unlock.json().catch(() => ({}))).message || 'Contraseña incorrecta.');
    manifestResponse = await fetch(`/api/shared/${match[1]}/manifest?token=${encodeURIComponent(token)}`);
  }
  const manifest = await manifestResponse.json().catch(() => ({}));
  if (!manifestResponse.ok) throw new Error(manifest.message || 'No se pudo abrir el proyecto compartido.');
  if (manifest.permission === 'view') {
    $('#measure-toggle').hidden = true;
    $('#measure-unit').hidden = true;
  }
  if (manifest.permission !== 'download') $('#capture-view').hidden = true;
  const accessQuery = `token=${encodeURIComponent(token)}`;
  const sharedMetadataPath = manifest.files.find(file => file.toLowerCase().endsWith('.metadata.json'));
  technicalMetadata = null;
  if (sharedMetadataPath) {
    const metadataResponse = await fetch(`/api/shared/${manifest.id}/file/${sharedMetadataPath.split('/').map(encodeURIComponent).join('/')}?${accessQuery}`);
    if (metadataResponse.ok) {
      const candidate = await metadataResponse.json().catch(() => null);
      if (candidate?.schema === 'modular-3d-view-metadata') technicalMetadata = candidate;
    }
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    const clean = decodeURIComponent(url).replace(/^\.\//, '');
    const path = manifest.files.find(file => file === clean || file.split('/').pop() === clean.split('/').pop());
    return path ? `/api/shared/${manifest.id}/file/${path.split('/').map(encodeURIComponent).join('/')}?${accessQuery}` : url;
  });
  const entryUrl = `/api/shared/${manifest.id}/file/${manifest.entry.split('/').map(encodeURIComponent).join('/')}?${accessQuery}`;
  const response = await fetch(entryUrl);
  if (!response.ok) throw new Error('No se pudo descargar el modelo compartido.');
  if (/\.glb$/i.test(manifest.entry)) {
    const blobUrl = URL.createObjectURL(await response.blob());
    model = (await new GLTFLoader(manager).loadAsync(blobUrl)).scene;
    URL.revokeObjectURL(blobUrl);
  } else if (/\.gltf$/i.test(manifest.entry)) {
    model = (await new GLTFLoader(manager).parseAsync(await response.text(), '')).scene;
  } else {
    model = new ColladaLoader(manager).parse(await response.text(), '').scene;
  }
  model.traverse(item => { if (item.isMesh) { item.castShadow = true; item.receiveShadow = true; } });
  scene.add(model);
  rememberModelState();
  $('#viewer-title').textContent = manifest.name;
  frameModel();
  $('#viewer-message').textContent = 'Proyecto compartido · MODULAR-3D VIEW';
  return true;
}

async function optimizedGlbFile() {
  if (!model) throw new Error('No hay un modelo cargado.');
  $('#viewer-message').textContent = 'Optimizando el modelo a un solo archivo GLB…';
  const data = await new GLTFExporter().parseAsync(model, { binary: true, onlyVisible: false, trs: false });
  return new File([data], `${$('#viewer-title').textContent || 'modelo'}.glb`, { type: 'model/gltf-binary' });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

async function copyText(value) {
  if (navigator.clipboard) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

async function loadPublishedProjects() {
  const list = $('#published-list');
  try {
    const data = await request('/api/models');
    const storage = data.storage;
    const percent = Math.min(storage.percent, 100);
    $('#storage-percent').textContent = `${percent.toFixed(2)}%`;
    $('#storage-text').textContent = `${formatBytes(storage.usedBytes)} utilizados · límite preventivo ${formatBytes(storage.safeLimitBytes)} · nivel gratuito ${formatBytes(storage.freeBytes)}`;
    $('#storage-bar').style.width = `${percent}%`;
    $('#storage-bar').style.background = percent >= 90 ? '#c53f24' : percent >= 80 ? '#e79b25' : '#45a96b';
    $('#storage-alert').hidden = !storage.warning;
    $('#storage-alert').textContent = storage.usedBytes >= storage.safeLimitBytes
      ? 'Publicación bloqueada: elimina proyectos para mantenerte por debajo de 9 GB.'
      : 'Advertencia: superaste 8 GB. Conviene eliminar proyectos antiguos antes de seguir publicando.';
    if (!data.models.length) {
      list.innerHTML = '<p class="muted">Todavía no hay proyectos publicados.</p>';
      return;
    }
    list.innerHTML = data.models.map(item => {
      const expiration = item.expiresAt ? new Date(item.expiresAt).toLocaleDateString('es-EC') : 'Sin vencimiento';
      return `<article class="published-card" data-model-id="${item.id}"><div><strong class="project-name">${item.name.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]))} <em>V${item.version || 1}</em></strong><small>${formatBytes(item.sizeBytes)} · publicado ${new Date(item.createdAt).toLocaleDateString('es-EC')} · vence ${expiration} · ${item.active ? 'Activo' : 'Desactivado'}</small></div><div class="project-actions"><button data-action="copy" data-url="${item.url}">Copiar enlace</button><button data-action="rename">Renombrar</button><button data-action="token">Renovar enlace</button><button data-action="toggle" data-active="${item.active}">${item.active ? 'Desactivar' : 'Activar'}</button><button class="danger" data-action="delete">Eliminar</button></div></article>`;
    }).join('');
  } catch (error) {
    list.innerHTML = `<p class="message error">${error.message}</p>`;
  }
}

async function loadAdminSummary() {
  const card = $('#admin-card');
  try {
    const data = await request('/api/admin/summary');
    card.hidden = false;
    $('#admin-summary').innerHTML = `<p><strong>${data.projects}</strong> proyectos · <strong>${formatBytes(data.usedBytes)}</strong> en R2</p><div class="admin-owners">${data.owners.map(owner => `<div><span>${escapeHtml(owner.owner)}</span><strong>${owner.projects} · ${formatBytes(owner.bytes)}</strong></div>`).join('')}</div>`;
  } catch (error) {
    if (error.message !== 'forbidden') $('#admin-summary').textContent = error.message;
  }
}

async function publishForMobile() {
  if (!currentFiles.length) throw new Error('Abre primero una exportación de SketchUp.');
  const assessment = assessModelForPublishing();
  if (assessment.blocked) throw new Error(assessment.message);
  if (assessment.warnings.length && !confirm(`Revisión previa:\n\n${assessment.warnings.map(item => `• ${item}`).join('\n')}\n\n¿Deseas publicar de todas maneras?`)) return;
  const button = $('#publish-mobile');
  button.disabled = true;
  const original = button.textContent;
  let created;
  try {
    const publishFile = currentFiles.length === 1 && /\.glb$/i.test(currentFiles[0].name) ? currentFiles[0] : await optimizedGlbFile();
    const metadataFile = currentFiles.find(file => file.name.toLowerCase().endsWith('.metadata.json'));
    const filesToUpload = [publishFile, ...(metadataFile ? [metadataFile] : [])];
    const totalSize = filesToUpload.reduce((total, file) => total + file.size, 0);
    created = await request('/api/models/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('#viewer-title').textContent || 'Proyecto', totalSize, expiresDays: Number($('#share-expiry').value), password: $('#share-password').value, permission: $('#share-permission').value })
    });
    const paths = [];
    for (let index = 0; index < filesToUpload.length; index += 1) {
      const file = filesToUpload[index];
      const path = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name;
      paths.push({ path, size: file.size });
      button.textContent = `Subiendo ${index + 1} de ${filesToUpload.length}…`;
      const response = await fetch(`/api/models/${created.id}/files/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file
      });
      if (!response.ok) throw new Error('No se pudo subir uno de los archivos del modelo.');
    }
    const result = await request(`/api/models/${created.id}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: paths })
    });
    $('#share-url').value = result.url;
    $('#share-panel').hidden = false;
    await loadPublishedProjects();
  } catch (error) {
    if (created?.id) await request(`/api/models/${created.id}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$('#license-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#license-message');
  message.classList.remove('error');
  message.textContent = 'Validando licencia…';
  try {
    const result = await request('/api/license/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('#email').value.trim(), licenseKey: $('#license-key').value.trim() })
    });
    message.textContent = result.message;
    $('#profile-email').textContent = $('#email').value.trim();
    show('import');
    await loadPublishedProjects();
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
});

$('#model-file').addEventListener('change', event => {
  const file = event.target.files[0];
  if (file) openFile(file).catch(error => { $('#import-message').textContent = error.message; });
});
$('#sketchup-folder').addEventListener('change', event => {
  if (event.target.files.length) openSketchUpExport(event.target.files).catch(error => {
    $('#import-message').textContent = error.message;
    $('#import-message').classList.add('error');
  });
});
const dropZone = $('#drop-zone');
dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  const file = event.dataTransfer.files[0];
  if (file) openFile(file).catch(error => { $('#import-message').textContent = error.message; });
});
$('#fit-model').addEventListener('click', frameModel);
$('#publish-mobile').addEventListener('click', () => publishForMobile().catch(error => {
  $('#viewer-message').textContent = error.message;
}));
$('#copy-link').addEventListener('click', async () => {
  await copyText($('#share-url').value);
  $('#copy-link').textContent = 'Copiado';
  setTimeout(() => { $('#copy-link').textContent = 'Copiar enlace'; }, 1600);
});
$('#back-import').addEventListener('click', () => { show('import'); loadPublishedProjects(); });
$('#refresh-projects').addEventListener('click', loadPublishedProjects);
$('#refresh-admin').addEventListener('click', loadAdminSummary);
$('#published-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  const card = event.target.closest('[data-model-id]');
  if (!button || !card) return;
  const id = card.dataset.modelId;
  try {
    if (button.dataset.action === 'copy') {
      await copyText(button.dataset.url);
      button.textContent = 'Copiado';
      return;
    }
    if (button.dataset.action === 'delete') {
      if (!confirm('¿Eliminar definitivamente este proyecto y todos sus archivos?')) return;
      await request(`/api/models/${id}`, { method: 'DELETE' });
    }
    if (button.dataset.action === 'rename') {
      const name = prompt('Nuevo nombre del proyecto:', card.querySelector('.project-name').textContent);
      if (!name) return;
      await request(`/api/models/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    }
    if (button.dataset.action === 'token') {
      const result = await request(`/api/models/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ regenerateToken: true, active: true }) });
      await copyText(result.url);
      alert('Enlace nuevo copiado. El enlace anterior dejó de funcionar.');
    }
    if (button.dataset.action === 'toggle') {
      await request(`/api/models/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: button.dataset.active !== 'true' }) });
    }
    await loadPublishedProjects();
  } catch (error) { alert(error.message); }
});
$('#model-search').addEventListener('input', event => buildComponentTree(event.target.value));
$('#component-tree').addEventListener('click', event => {
  const button = event.target.closest('[data-mesh-id]');
  if (!button) return;
  selectObject(modelMeshes().find(mesh => mesh.userData.m3dId === button.dataset.meshId));
});
$('#hide-selected').addEventListener('click', () => {
  if (!selectedObject) return;
  selectedObject.visible = false;
  selectObject(null);
  buildComponentTree($('#model-search').value);
  requestRender();
});
$('#isolate-selected').addEventListener('click', () => {
  if (!selectedObject) return;
  modelMeshes().forEach(mesh => { mesh.visible = mesh === selectedObject; });
  buildComponentTree($('#model-search').value);
  requestRender();
});
$('#isolate-same').addEventListener('click', () => {
  if (!selectedObject) return;
  const metadata = selectedObject.userData.m3dMeta;
  const match = mesh => metadata
    ? mesh.userData.m3dMeta?.definition === metadata.definition
    : mesh.userData.m3dName === selectedObject.userData.m3dName;
  modelMeshes().forEach(mesh => { mesh.visible = match(mesh); });
  buildComponentTree($('#model-search').value);
  requestRender();
});
$('#show-all').addEventListener('click', () => {
  modelMeshes().forEach(mesh => { mesh.visible = true; });
  buildComponentTree($('#model-search').value);
  requestRender();
});
$('#opacity-range').addEventListener('input', event => {
  const opacity = Number(event.target.value) / 100;
  $('#opacity-output').value = `${event.target.value}%`;
  if (!selectedObject) return;
  (Array.isArray(selectedObject.material) ? selectedObject.material : [selectedObject.material]).forEach(material => {
    material.transparent = opacity < 1;
    material.opacity = opacity;
    material.needsUpdate = true;
  });
  requestRender();
});
$('#explode-range').addEventListener('input', event => {
  const amount = Number(event.target.value) / 100;
  $('#explode-output').value = `${event.target.value}%`;
  const center = originalModelCenter;
  const scale = Math.max(originalModelSize.x, originalModelSize.y, originalModelSize.z, 1) * .42 * amount;
  originalMeshState.forEach((state, mesh) => {
    const direction = state.worldCenter.clone().sub(center).normalize();
    mesh.position.copy(state.position).add(direction.multiplyScalar(scale));
  });
  selectionHelper?.update();
  updateModuleDimensions();
  requestRender();
});
$('#section-axis').addEventListener('change', event => {
  const axis = event.target.value;
  $('#section-range').disabled = axis === 'none';
  sectionPlane = axis === 'none' ? null : new THREE.Plane(new THREE.Vector3(axis === 'x' ? -1 : 0, axis === 'y' ? -1 : 0, axis === 'z' ? -1 : 0), 0);
  renderer.localClippingEnabled = Boolean(sectionPlane);
  modelMeshes().forEach(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => { material.clippingPlanes = sectionPlane ? [sectionPlane] : []; material.needsUpdate = true; }));
  requestRender();
});
$('#section-range').addEventListener('input', event => {
  if (sectionPlane) sectionPlane.constant = modelMaximumSize() * Number(event.target.value) / 200;
  requestRender();
});
$('#save-note').addEventListener('click', () => {
  if (!selectedObject) return alert('Selecciona primero un componente.');
  objectNotes.set(selectedObject.userData.m3dId, $('#object-note').value.trim());
  $('#viewer-message').textContent = 'Nota guardada en este dispositivo.';
});
$('#select-toggle').addEventListener('click', event => {
  selectionMode = !selectionMode;
  event.currentTarget.classList.toggle('active', selectionMode);
});
$('#open-model-panel').addEventListener('click', () => $('#model-panel').classList.add('open'));
$('#panel-toggle').addEventListener('click', () => $('#model-panel').classList.remove('open'));
$('#projection-toggle').addEventListener('click', () => switchProjection(camera?.isOrthographicCamera ? 'perspective' : 'orthographic'));
$('#module-dimensions-toggle').addEventListener('click', event => {
  const panel = $('#module-dimensions');
  panel.hidden = !panel.hidden;
  event.currentTarget.classList.toggle('active', !panel.hidden);
  updateModuleDimensions();
});
$('#measure-unit').addEventListener('change', () => {
  updatePieceProperties(selectedObject);
  updateModuleDimensions();
});
$('#grid-toggle').addEventListener('click', event => {
  gridHelper.visible = !gridHelper.visible;
  event.currentTarget.classList.toggle('active', gridHelper.visible);
  requestRender();
});
$('#shadow-toggle').addEventListener('click', event => {
  renderer.shadowMap.enabled = !renderer.shadowMap.enabled;
  if (model) model.traverse(item => { if (item.isMesh) { item.castShadow = renderer.shadowMap.enabled; item.receiveShadow = renderer.shadowMap.enabled; } });
  event.currentTarget.classList.toggle('active', renderer.shadowMap.enabled);
  requestRender();
});
$('#background-toggle').addEventListener('click', event => {
  darkBackground = !darkBackground;
  scene.background = new THREE.Color(darkBackground ? 0x111417 : 0xe8edf1);
  event.currentTarget.classList.toggle('active', !darkBackground);
  requestRender();
});
$('#fullscreen-toggle').addEventListener('click', async () => {
  if (!document.fullscreenElement) await $('#viewer-stage').requestFullscreen(); else await document.exitFullscreen();
});
$('#capture-view').addEventListener('click', () => {
  renderer.render(scene, camera);
  const link = document.createElement('a');
  link.download = `${$('#viewer-title').textContent || 'modelo'}-vista.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
});
$('#measure-toggle').addEventListener('click', event => {
  measureMode = !measureMode;
  event.currentTarget.classList.toggle('active', measureMode);
  controls.enabled = !measureMode;
  if (!measureMode) {
    clearMeasurement();
    $('#viewer-message').textContent = 'Arrastra para orbitar · rueda para zoom';
  } else $('#viewer-message').textContent = 'Selecciona dos puntos sobre el modelo.';
});
$('#set-front').addEventListener('click', () => {
  const direction = currentViewDirection();
  direction.y = 0;
  if (direction.lengthSq() < .01) return alert('Gira primero hacia una vista horizontal para definir el frente.');
  direction.normalize();
  frontOffset = Math.atan2(direction.x, direction.z) - Math.PI;
  localStorage.setItem('m3d-front-offset', String(frontOffset));
  updateNavigator();
  alert('La orientación actual quedó definida como FRENTE para este navegador.');
});
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); show('license'); });
initializeNavigator();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
loadSharedModel().catch(error => {
  show('viewer');
  $('#viewer-message').textContent = error.message;
}).then(shared => {
  if (shared) return;
  return request('/api/session').then(session => {
    if (session.licensed) {
      $('#profile-email').textContent = session.email || 'Usuario autorizado';
      show('import');
      loadPublishedProjects();
      if (session.isAdmin) loadAdminSummary();
    }
  });
}).catch(() => {});
