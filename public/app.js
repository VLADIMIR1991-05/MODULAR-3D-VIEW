import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';

const screens = ['license', 'import', 'viewer'];
const $ = selector => document.querySelector(selector);
let objectUrl, renderer, scene, camera, controls, model;

function show(name) {
  screens.forEach(item => {
    `#${item}-screen`;
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

async function openFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['glb', 'gltf'].includes(extension)) throw new Error('Selecciona un archivo .GLB o .GLTF.');
  if (file.size > 250 * 1024 * 1024) throw new Error('El modelo supera el límite local de 250 MB.');
  initializeViewer();
  if (model) scene.remove(model);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  $('#viewer-title').textContent = file.name.replace(/\.(glb|gltf)$/i, '');
  $('#viewer-message').textContent = 'Cargando geometría y materiales…';
  show('viewer');
  const gltf = await new GLTFLoader().loadAsync(objectUrl);
  model = gltf.scene;
  model.traverse(item => {
    if (item.isMesh) { item.castShadow = true; item.receiveShadow = true; }
  });
  scene.add(model);
  frameModel();
  $('#viewer-message').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
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
$('#back-import').addEventListener('click', () => show('import'));
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); show('license'); });
request('/api/session').then(session => {
  if (session.licensed) {
    $('#profile-email').textContent = session.email || 'Usuario autorizado';
    show('import');
  }
}).catch(() => {});
