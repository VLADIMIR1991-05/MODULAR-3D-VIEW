const screens = ['license', 'trimble', 'projects', 'viewer'];
const $ = selector => document.querySelector(selector);

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

function normalizeProjects(payload) {
  const list = Array.isArray(payload) ? payload : payload.projects || payload.items || [];
  return list.map(project => ({ id: project.id || project.projectId, name: project.name || project.title || 'Proyecto sin nombre', updated: project.modifiedOn || project.updatedAt || 'Disponible en Trimble Connect' })).filter(project => project.id);
}

function renderProjects(projects) {
  const grid = $('#project-grid');
  grid.replaceChildren();
  projects.forEach(project => {
    const button = document.createElement('button');
    button.className = 'project-card';
    button.innerHTML = `<span class="project-icon">◇</span><span><strong></strong><small></small></span><b>→</b>`;
    button.querySelector('strong').textContent = project.name;
    button.querySelector('small').textContent = project.updated;
    button.addEventListener('click', () => openViewer(project));
    grid.append(button);
  });
}

async function openViewer(project) {
  $('#viewer-title').textContent = project.name;
  $('#viewer-stage').dataset.projectId = project.id;
  show('viewer');
  await loadTrimbleViewer(project.id);
}

async function loadTrimbleViewer(projectId) {
  const frame = $('#connect-frame');
  const placeholder = $('#viewer-placeholder');
  const message = $('#viewer-message');
  message.textContent = 'Conectando con el visor oficial de Trimble…';
  placeholder.hidden = false;
  frame.hidden = true;
  try {
    if (!window.TrimbleConnectWorkspace) throw new Error('No se cargó la API de Trimble Connect.');
    const session = await request('/api/trimble/embed-session');
    frame.src = window.TrimbleConnectWorkspace.getConnectEmbedUrl('prod');
    const api = await window.TrimbleConnectWorkspace.connect(frame, (event) => {
      if (event === 'embed.pageLoaded') { frame.hidden = false; placeholder.hidden = true; }
      if (event === 'embed.session.invalid') message.textContent = 'La sesión de Trimble expiró. Vuelve a conectarla.';
    }, 30000);
    await api.embed.setTokens({ accessToken: session.accessToken, expiresIn: session.expiresIn });
    await api.embed.init3DViewer({ projectId });
    frame.hidden = false;
    placeholder.hidden = true;
  } catch (error) {
    message.textContent = error.message || 'No se pudo iniciar el visor 3D.';
  }
}

async function loadProjects() {
  $('#projects-message').textContent = 'Cargando proyectos…';
  try {
    const session = await request('/api/session');
    $('#profile-email').textContent = session.email || 'Usuario conectado';
    const projects = normalizeProjects(await request('/api/projects'));
    renderProjects(projects);
    $('#projects-message').textContent = projects.length ? '' : 'No se encontraron proyectos para esta cuenta.';
    show('projects');
  } catch (error) { $('#projects-message').textContent = error.message; $('#projects-message').classList.add('error'); }
}

$('#license-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('#license-message');
  message.classList.remove('error'); message.textContent = 'Validando licencia…';
  try {
    const result = await request('/api/license/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('#email').value.trim(), licenseKey: $('#license-key').value.trim() }) });
    message.textContent = result.message; show('trimble');
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
});

$('#back-projects').addEventListener('click', () => { $('#connect-frame').src = 'about:blank'; show('projects'); });
$('#logout').addEventListener('click', async () => { await request('/api/logout', { method: 'POST' }); show('license'); });

const params = new URLSearchParams(location.search);
if (params.get('connected') === '1') { history.replaceState({}, '', '/'); loadProjects(); }
else if (params.has('error')) { $('#license-message').textContent = `No se pudo continuar: ${params.get('error')}`; $('#license-message').classList.add('error'); history.replaceState({}, '', '/'); }
else request('/api/session').then(session => { if (session.trimbleConnected) loadProjects(); else if (session.licensed) show('trimble'); }).catch(() => {});
