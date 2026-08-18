import * as THREE from 'https://esm.sh/three@0.180.0';
import { OrbitControls } from 'https://esm.sh/three@0.180.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
import { ColladaLoader } from 'https://esm.sh/three@0.180.0/examples/jsm/loaders/ColladaLoader.js';

const screens = ['license', 'import', 'viewer'];
const $ = selector => document.querySelector(selector);
let objectUrl, renderer, scene, camera, controls, model;
let currentFiles = [];
let navigatorDragging = false;

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
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  stage.prepend(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.addEventListener('change', updateNavigator);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.5));
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(8, 12, 6);
  scene.add(sun, new THREE.GridHelper(40, 40, 0x52606d, 0x2a323a));
  new ResizeObserver(() => {
    camera.aspect = stage.clientWidth / stage.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  }).observe(stage);
  (function animate() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }());
}

function frameModel() {
  if (!model) return;
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z, 1) * 1.8;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.65, distance));
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function modelCenter() {
  return model ? new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()) : controls.target.clone();
}

function moveCameraTo(direction, duration = 360) {
  if (!camera || !controls) return;
  const target = modelCenter();
  const distance = Math.max(camera.position.distanceTo(controls.target), 1);
  const end = target.clone().add(direction.clone().normalize().multiplyScalar(distance));
  if (duration <= 0) {
    camera.position.copy(end);
    controls.target.copy(target);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    controls.update();
    return;
  }
  const start = camera.position.clone();
  const startTarget = controls.target.clone();
  const began = performance.now();
  const animateMove = now => {
    const progress = Math.min((now - began) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    camera.position.lerpVectors(start, end, eased);
    controls.target.lerpVectors(startTarget, target, eased);
    camera.up.set(0, 1, 0);
    camera.lookAt(controls.target);
    controls.update();
    if (progress < 1) requestAnimationFrame(animateMove);
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
  const horizontal = Math.atan2(direction.x, direction.z);
  const names = ['FRENTE', 'DERECHA', 'ATRÁS', 'IZQUIERDA'];
  let index = Math.round(horizontal / (Math.PI / 2));
  index = ((index % 4) + 4) % 4;
  let label = names[index];
  if (direction.y > .82) label = 'ARRIBA';
  if (direction.y < -.82) label = 'ABAJO';
  $('#nav-label').textContent = label;
}

function initializeNavigator() {
  const navigator = $('#view-navigator');
  navigator.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', event => {
      if (navigatorDragging) return;
      const [x, y, z] = event.currentTarget.dataset.view.split(',').map(Number);
      const current = currentViewDirection();
      const quarter = Math.round(Math.atan2(current.x, current.z) / (Math.PI / 2)) * (Math.PI / 2);
      const direction = new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), quarter);
      moveCameraTo(direction);
      navigator.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === event.currentTarget));
    });
  });
  navigator.querySelectorAll('[data-orbit]').forEach(button => button.addEventListener('click', () => orbitStep(button.dataset.orbit)));
  $('#nav-home').addEventListener('click', () => moveCameraTo(new THREE.Vector3(1, .65, 1)));
  const face = $('#nav-face');
  let previous = null;
  face.addEventListener('pointerdown', event => {
    navigatorDragging = false;
    previous = { x: event.clientX, y: event.clientY };
    face.setPointerCapture(event.pointerId);
  });
  face.addEventListener('pointermove', event => {
    if (!previous) return;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) navigatorDragging = true;
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
  model.traverse(item => {
    if (item.isMesh) { item.castShadow = true; item.receiveShadow = true; }
  });
  scene.add(model);
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
  const text = await dae.text();
  const collada = new ColladaLoader(manager).parse(text, '');
  model = collada.scene;
  model.traverse(item => {
    if (item.isMesh) { item.castShadow = true; item.receiveShadow = true; }
  });
  scene.add(model);
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
  $('#back-import').hidden = true;
  $('#viewer-message').textContent = 'Descargando proyecto compartido…';
  const manifest = await request(`/api/shared/${match[1]}/manifest?token=${encodeURIComponent(token)}`);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    const clean = decodeURIComponent(url).replace(/^\.\//, '');
    const path = manifest.files.find(file => file === clean || file.split('/').pop() === clean.split('/').pop());
    return path ? `/api/shared/${manifest.id}/file/${path.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(token)}` : url;
  });
  const entryUrl = `/api/shared/${manifest.id}/file/${manifest.entry.split('/').map(encodeURIComponent).join('/')}?token=${encodeURIComponent(token)}`;
  const response = await fetch(entryUrl);
  if (!response.ok) throw new Error('No se pudo descargar el modelo compartido.');
  const collada = new ColladaLoader(manager).parse(await response.text(), '');
  model = collada.scene;
  scene.add(model);
  $('#viewer-title').textContent = manifest.name;
  frameModel();
  $('#viewer-message').textContent = 'Proyecto compartido · MODULAR-3D VIEW';
  return true;
}

async function publishForMobile() {
  if (!currentFiles.length) throw new Error('Abre primero una exportación de SketchUp.');
  const button = $('#publish-mobile');
  button.disabled = true;
  const original = button.textContent;
  try {
    const dae = currentFiles.find(file => file.name.toLowerCase().endsWith('.dae'));
    const created = await request('/api/models/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: dae ? dae.name.replace(/\.dae$/i, '') : 'Proyecto' })
    });
    const paths = [];
    for (let index = 0; index < currentFiles.length; index += 1) {
      const file = currentFiles[index];
      const path = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name;
      paths.push(path);
      button.textContent = `Subiendo ${index + 1} de ${currentFiles.length}…`;
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
  await navigator.clipboard.writeText($('#share-url').value);
  $('#copy-link').textContent = 'Copiado';
  setTimeout(() => { $('#copy-link').textContent = 'Copiar enlace'; }, 1600);
});
$('#back-import').addEventListener('click', () => show('import'));
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); show('license'); });
initializeNavigator();
loadSharedModel().catch(error => {
  show('viewer');
  $('#viewer-message').textContent = error.message;
}).then(shared => {
  if (shared) return;
  return request('/api/session').then(session => {
    if (session.licensed) {
      $('#profile-email').textContent = session.email || 'Usuario autorizado';
      show('import');
    }
  });
}).catch(() => {});
