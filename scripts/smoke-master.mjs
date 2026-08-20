const baseUrl = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
const masterEmail = String(process.env.MASTER_EMAIL || '').trim();
const masterPassword = String(process.env.MASTER_PANEL_PASSWORD || '');
if (!baseUrl || !masterEmail || !masterPassword) throw new Error('Faltan variables para la prueba del panel maestro.');

async function request(path, options = {}, cookie = '') {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${data.message || data.code || 'error'}`);
  return { data, response };
}

const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const email = `smoke-${stamp}@example.invalid`;
const firstPassword = `M3D-Smoke-${stamp}`;
const secondPassword = `${firstPassword}-Nueva`;
let userId = null;
let cookie = '';

try {
  const login = await request('/api/master/login', {
    method: 'POST',
    body: JSON.stringify({ email: masterEmail, password: masterPassword })
  });
  cookie = String(login.response.headers.get('set-cookie') || '').split(';', 1)[0];
  if (!cookie) throw new Error('El inicio maestro no devolvió una sesión.');

  const created = await request('/api/master/users/save', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Prueba automática de despliegue',
      email,
      password: firstPassword,
      products: [{ code: 'modular3d_view', enabled: true, days: 1, plan: 'smoke', max_devices: 1, status: 'active' }]
    })
  }, cookie);
  userId = Number(created.data.id);
  if (!userId) throw new Error('No se recibió el identificador del usuario temporal.');

  await request('/api/master/users/change-password', {
    method: 'POST',
    body: JSON.stringify({ id: userId, password: secondPassword })
  }, cookie);

  await request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: secondPassword, product_code: 'modular3d_view', machine_id: `smoke-machine-${stamp}` })
  });

  console.log('Prueba real aprobada: usuario, contraseña y acceso multiproducto.');
} finally {
  if (userId && cookie) {
    await request('/api/master/users/delete', {
      method: 'POST',
      body: JSON.stringify({ id: userId })
    }, cookie).catch(error => console.error(`No se pudo limpiar el usuario temporal: ${error.message}`));
  }
}
