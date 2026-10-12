const app = document.querySelector('#app');
const topbarMeta = document.querySelector('#topbar-meta');
const themeToggle = document.querySelector('#theme-toggle');
const money = (amount) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(amount);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let toastTimer;
let dashboardOrdersSnapshot = '';
let dashboardOrdersRefresh = null;

function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#121914' : '#f7f8f6';
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Activar modo claro' : 'Activar modo oscuro');
  themeToggle.title = theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  themeToggle.textContent = theme === 'dark' ? '☀' : '◐';
  if (persist) {
    try { localStorage.setItem('tably-theme', theme); } catch {}
  }
}

let savedTheme;
try { savedTheme = localStorage.getItem('tably-theme'); } catch {}
setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

function stopDashboardPolling() {
  clearInterval(window.tablyDashboardPoll);
  window.tablyDashboardPoll = null;
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'No se pudo completar la operación.');
  return body;
}

function busyButton(button, busy, label) {
  button.disabled = busy;
  button.textContent = busy ? 'Un momento…' : label;
}

function renderAuth(showRegister = false) {
  stopDashboardPolling();
  topbarMeta.textContent = 'Pedidos y mesas en orden';
  app.innerHTML = `<div class="auth-wrap">
    <section class="intro"><div class="intro-mark">Menos espera, más servicio</div>
      <h1>El salón sigue en movimiento.</h1>
      <p>Pedidos desde cada mesa, comanda al instante y cobros directos a la cuenta de tu café.</p>
    </section>
    <section class="panel" aria-label="Acceso al local">
      <h2>${showRegister ? 'Abrí tu café en Tably' : 'Entrar al local'}</h2>
      <p class="muted small">${showRegister ? 'Empezá con tu menú y tus mesas. Vincularás Mercado Pago mediante autorización segura, sin compartir claves.' : 'Gestioná pedidos, mesas y cobros.'}</p>
      <form class="form" id="auth-form">
        ${showRegister ? `<div class="field"><label for="cafe-name">Nombre del café</label><input id="cafe-name" name="name" required minlength="2" maxlength="80" autocomplete="organization"></div>` : ''}
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label for="password">Contraseña</label><input id="password" name="password" type="password" required minlength="${showRegister ? '10' : '1'}" autocomplete="${showRegister ? 'new-password' : 'current-password'}"></div>
        ${showRegister ? `<div class="field"><label for="table-count">Cantidad de mesas</label><input id="table-count" name="tableCount" type="number" min="1" max="200" value="10" required><span class="muted small">Hasta 15 mesas: Base · Más de 15: Ampliado</span></div>` : ''}
        <button class="btn primary" type="submit">${showRegister ? 'Crear cuenta' : 'Ingresar'}</button>
      </form>
      <div class="switch">${showRegister ? '¿Ya tenés cuenta?' : '¿Todavía no tenés cuenta?'} <button class="text-btn" id="auth-switch">${showRegister ? 'Ingresá' : 'Crear cuenta'}</button></div>
    </section>
  </div>`;
  document.querySelector('#auth-switch').addEventListener('click', () => renderAuth(!showRegister));
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const label = showRegister ? 'Crear cuenta' : 'Ingresar';
    busyButton(button, true, label);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (showRegister) data.tableCount = Number(data.tableCount);
    try {
      await api(`/api/auth/${showRegister ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(data) });
      if (showRegister) {
        const config = await api('/api/mercadopago/config').catch(() => ({ oauthEnabled: false }));
        if (config.oauthEnabled) {
          location.assign('/api/mercadopago/connect');
          return;
        }
        await renderDashboard();
        toast('Cuenta creada. Vinculá Mercado Pago desde el panel para cobrar pedidos online.');
        return;
      }
      await renderDashboard();
    } catch (error) {
      toast(error.message);
      busyButton(button, false, label);
    }
  });
}

function orderCard(order) {
  const items = order.items.map((item) => `${item.quantity} × ${esc(item.name)}`).join(', ');
  const payment = order.paymentMethod === 'mercadopago' ? 'Mercado Pago' : order.paymentMethod === 'cash' ? 'Efectivo' : 'Tarjeta en mesa';
  const actions = [];
  if (order.paymentStatus === 'pending' && order.paymentMethod !== 'mercadopago') {
    actions.push(`<button class="btn green small-btn" data-cash-paid="${order.id}">Confirmar cobro</button>`);
  }
  const next = { received: 'preparing', preparing: 'ready', ready: 'delivered' }[order.orderStatus];
  if (order.paymentStatus === 'approved' && next) {
    actions.push(`<button class="btn secondary small-btn" data-next-status="${order.id}" data-status="${next}">Pasar a ${next === 'preparing' ? 'preparando' : next === 'ready' ? 'listo' : 'entregado'}</button>`);
  }
  const waitingForCollection = order.paymentStatus === 'pending' && order.paymentMethod !== 'mercadopago';
  const waitingForMp = order.paymentStatus === 'pending' && order.paymentMethod === 'mercadopago';
  return `<article class="order"><div>${waitingForCollection ? `<span class="pill collection-needed">Acercarse a mesa ${order.tableNumber} · cobrar ${payment}</span>` : ''}${waitingForMp ? `<span class="pill">Esperando confirmación de Mercado Pago</span>` : ''}<strong>Mesa ${order.tableNumber} · ${money(order.totalArs)}</strong>
    <div class="order-detail">${items}<br>${payment} · ${order.paymentStatus === 'approved' ? 'Pagado' : 'Pendiente'} · ${order.orderStatus}</div></div>
    <div class="order-actions">${actions.join('')}</div></article>`;
}

function orderListHtml(orders) {
  const groups = [
    ['Cobros en mesa', orders.filter((order) => order.paymentStatus === 'pending' && order.paymentMethod !== 'mercadopago'), 'No hay mesas esperando el cobro del personal.'],
    ['Esperando Mercado Pago', orders.filter((order) => order.paymentStatus === 'pending' && order.paymentMethod === 'mercadopago'), 'No hay pagos online pendientes. Los pedidos no llegan a cocina hasta confirmar el pago.'],
    ['Comanda', orders.filter((order) => order.paymentStatus === 'approved' && order.orderStatus !== 'delivered'), 'No hay pedidos pagados en preparación.'],
    ['Entregados', orders.filter((order) => order.paymentStatus === 'approved' && order.orderStatus === 'delivered'), 'Todavía no hay pedidos entregados.'],
  ];
  return groups.map(([title, groupOrders, emptyText]) => `<section class="order-group">
    <div class="order-group-head"><h3>${title}</h3><span class="pill ${groupOrders.length ? 'green' : ''}">${groupOrders.length}</span></div>
    <div class="orders">${groupOrders.length ? groupOrders.map(orderCard).join('') : `<div class="empty">${emptyText}</div>`}</div>
  </section>`).join('');
}

function menuItemHtml(item) {
  return `<form class="menu-edit" data-menu-id="${item.id}">
    <div class="menu-inputs"><input class="menu-input" name="name" value="${esc(item.name)}" aria-label="Nombre del producto" required maxlength="100">
      <input class="menu-input" name="category" value="${esc(item.category)}" aria-label="Categoría" required maxlength="40">
      <input class="menu-input" name="description" value="${esc(item.description)}" aria-label="Descripción" maxlength="240">
      <input class="menu-input" name="priceArs" type="number" min="1" step="1" value="${item.priceArs}" aria-label="Precio en pesos argentinos" required></div>
    <div class="menu-edit-actions"><label class="active-toggle"><input name="active" type="checkbox" ${item.active ? 'checked' : ''}> Disponible</label>
      <button class="btn secondary small-btn" type="submit">Guardar</button>
      ${item.active ? `<button class="menu-delete" type="button" data-menu-delete="${item.id}" aria-label="Eliminar ${esc(item.name)} del menú" title="Eliminar del menú"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3M3 7h18"/></svg></button>` : ''}</div>
    <div class="menu-edit-status" aria-live="polite"></div>
  </form>`;
}

function syncMenuSaveAll() {
  const dirtyCount = document.querySelectorAll('.menu-edit.is-dirty').length;
  const saveAll = document.querySelector('#save-all-menu');
  const status = document.querySelector('#menu-save-status');
  if (!saveAll || !status) return;
  saveAll.textContent = dirtyCount ? `Guardar todo (${dirtyCount})` : 'Guardar todo';
  saveAll.disabled = dirtyCount === 0 || saveAll.dataset.saving === 'true';
  status.textContent = dirtyCount ? `${dirtyCount} ${dirtyCount === 1 ? 'producto pendiente' : 'productos pendientes'}` : 'Todos los cambios están guardados';
}

function menuFormData(form) {
  const data = Object.fromEntries(new FormData(form));
  data.priceArs = Number(data.priceArs);
  data.active = form.elements.active.checked;
  return data;
}

function markMenuFormSaved(form, statusText = 'Guardado') {
  form.classList.remove('is-dirty');
  form.querySelectorAll('input').forEach((input) => {
    if (input.type === 'checkbox') input.defaultChecked = input.checked;
    else input.defaultValue = input.value;
  });
  form.querySelector('.menu-edit-status').textContent = statusText;
  syncMenuSaveAll();
}

async function saveMenuForm(form) {
  const saveButton = form.querySelector('button[type="submit"]');
  saveButton.disabled = true;
  form.querySelector('.menu-edit-status').textContent = 'Guardando…';
  try {
    await api(`/api/admin/menu/${form.dataset.menuId}`, { method: 'PATCH', body: JSON.stringify(menuFormData(form)) });
    markMenuFormSaved(form);
  } catch (error) {
    form.querySelector('.menu-edit-status').textContent = 'No se pudo guardar. Tus cambios siguen acá.';
    throw error;
  } finally {
    saveButton.disabled = false;
    syncMenuSaveAll();
  }
}

function bindMenuEditForm(form) {
  if (form.dataset.bound === 'true') return;
  form.dataset.bound = 'true';
  const markDirty = () => {
    form.classList.add('is-dirty');
    form.querySelector('.menu-edit-status').textContent = 'Cambios sin guardar';
    syncMenuSaveAll();
  };
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await saveMenuForm(form); }
    catch (error) { toast(error.message); }
  });
  form.querySelector('[data-menu-delete]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!confirm('¿Eliminar este producto del menú? Los pedidos anteriores no cambian.')) return;
    button.disabled = true;
    try {
      await api(`/api/admin/menu/${form.dataset.menuId}`, { method: 'DELETE' });
      form.remove();
      syncMenuSaveAll();
      toast('Producto eliminado del menú. Los pedidos anteriores se conservaron.');
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  });
}

function bindMenuControls() {
  document.querySelectorAll('.menu-edit').forEach(bindMenuEditForm);
  const createForm = document.querySelector('#new-menu-form');
  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = createForm.querySelector('button[type="submit"]');
    button.disabled = true;
    const data = Object.fromEntries(new FormData(createForm));
    data.priceArs = Number(data.priceArs);
    try {
      const item = await api('/api/admin/menu', { method: 'POST', body: JSON.stringify(data) });
      createForm.reset();
      const list = document.querySelector('#menu-admin');
      list.insertAdjacentHTML('beforeend', menuItemHtml(item));
      bindMenuEditForm(list.lastElementChild);
      toast('Producto agregado.');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });

  document.querySelector('#save-all-menu')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const pendingForms = [...document.querySelectorAll('.menu-edit.is-dirty')];
    if (!pendingForms.length) return;
    button.dataset.saving = 'true';
    syncMenuSaveAll();
    const results = await Promise.allSettled(pendingForms.map(saveMenuForm));
    delete button.dataset.saving;
    syncMenuSaveAll();
    const failed = results.filter((result) => result.status === 'rejected').length;
    toast(failed ? `Se guardaron ${results.length - failed}; ${failed} siguen pendientes.` : `Se guardaron ${results.length} productos.`);
  });
  syncMenuSaveAll();
}

function bindOrderControls() {
  document.querySelectorAll('[data-cash-paid]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/orders/${button.dataset.cashPaid}/cash-payment`, { method: 'POST', body: '{}' });
      await refreshDashboardOrders();
    } catch (error) { button.disabled = false; toast(error.message); }
  }));

  document.querySelectorAll('[data-next-status]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/orders/${button.dataset.nextStatus}/status`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) });
      await refreshDashboardOrders();
    } catch (error) { button.disabled = false; toast(error.message); }
  }));
}

async function refreshDashboardOrders() {
  if (dashboardOrdersRefresh) await dashboardOrdersRefresh;
  const list = document.querySelector('#orders-list');
  if (!list || document.hidden) return;

  const refresh = (async () => {
    const orders = await api('/api/admin/orders');
    const snapshot = JSON.stringify(orders);
    if (snapshot === dashboardOrdersSnapshot) return;

    const scrollY = window.scrollY;
    const focusedButton = list.contains(document.activeElement) ? document.activeElement : null;
    const focusedAction = focusedButton?.dataset.cashPaid
      ? ['cashPaid', focusedButton.dataset.cashPaid]
      : focusedButton?.dataset.nextStatus
        ? ['nextStatus', focusedButton.dataset.nextStatus]
        : null;
    list.innerHTML = orderListHtml(orders);
    document.querySelector('[data-orders-count]').textContent = `${orders.length} pedidos`;
    dashboardOrdersSnapshot = snapshot;
    bindOrderControls();

    if (focusedAction) {
      const target = [...list.querySelectorAll('button')].find((button) => button.dataset[focusedAction[0]] === focusedAction[1]);
      target?.focus({ preventScroll: true });
    }
    window.scrollTo({ top: scrollY, behavior: 'instant' });
  })();

  dashboardOrdersRefresh = refresh;
  try { await refresh; }
  finally { if (dashboardOrdersRefresh === refresh) dashboardOrdersRefresh = null; }
}

async function renderDashboard() {
  stopDashboardPolling();
  app.innerHTML = '<div class="loading">Cargando tu local…</div>';
  try {
    const [restaurant, orders, tables, menu] = await Promise.all([
      api('/api/auth/me'), api('/api/admin/orders'), api('/api/admin/tables'), api('/api/admin/menu'),
    ]);
    topbarMeta.innerHTML = `${esc(restaurant.name)} <button class="text-btn" id="logout">Salir</button>`;
    const price = restaurant.tableCount > 15 ? 45000 : 30000;
    const subscriptionLabels = { trial: 'Prueba inicial · 30 días', pending: 'Autorización pendiente', authorized: 'Suscripción activa', cancelled: 'Suscripción cancelada', paused: 'Suscripción pausada' };
    const subscriptionLabel = subscriptionLabels[restaurant.subscriptionStatus] || 'Sin suscripción';
    const canStartSubscription = !['pending', 'authorized'].includes(restaurant.subscriptionStatus);
    const canCancelSubscription = ['pending', 'authorized'].includes(restaurant.subscriptionStatus) && restaurant.subscriptionId;
    const tableCards = tables.map((table) => `<article class="table">
      <div class="table-actions"><b>Mesa ${table.table}</b><a class="text-btn small" href="${esc(table.qrUrl)}" download="tably-${restaurant.slug}-mesa-${table.table}.png">Descargar QR</a></div>
      <img src="${esc(table.qrUrl)}" alt="QR para la mesa ${table.table}">
      <a href="${esc(table.url)}" target="_blank" rel="noreferrer">${esc(table.url)}</a>
    </article>`).join('');
    app.innerHTML = `<div class="heading-row"><div><h1>Panel del local</h1><p>${esc(restaurant.name)} · ${restaurant.tableCount} mesas · <a href="/menu/${esc(restaurant.slug)}?table=1" target="_blank" rel="noreferrer">Abrir menú</a></p></div>
      <span class="pill ${restaurant.mercadoPagoConnected ? 'green' : ''}">${restaurant.mercadoPagoConnected ? 'Mercado Pago conectado' : 'Conectá Mercado Pago'}</span></div>
      <div class="dashboard-grid"><div class="stack">
        <section class="section"><div class="section-head"><h2>Pedidos y cobros</h2><span class="pill" data-orders-count>${orders.length} pedidos</span></div>
          <div class="orders" id="orders-list">${orderListHtml(orders)}</div></section>
        <section class="section"><div class="section-head"><h2>Menú</h2><span class="muted small">Productos y precios del local</span></div>
          <div class="menu-toolbar"><span class="muted small" id="menu-save-status">Todos los cambios están guardados</span><button class="btn primary small-btn" id="save-all-menu" type="button" disabled>Guardar todo</button></div>
          <form class="menu-create" id="new-menu-form">
            <div class="menu-inputs"><input class="menu-input" name="name" placeholder="Nombre del producto" aria-label="Nombre del producto" required maxlength="100">
              <input class="menu-input" name="category" placeholder="Categoría" aria-label="Categoría" required maxlength="40">
              <input class="menu-input" name="description" placeholder="Descripción" aria-label="Descripción" maxlength="240">
              <input class="menu-input" name="priceArs" type="number" min="1" step="1" placeholder="Precio en ARS" aria-label="Precio en pesos argentinos" required></div>
            <button class="btn primary small-btn" type="submit">Agregar producto</button>
          </form>
          <div class="menu-admin" id="menu-admin">${menu.map(menuItemHtml).join('')}</div>
        </section>
        <section class="section"><div class="section-head"><h2>QR por mesa</h2><span class="muted small">Enlaces listos para compartir</span></div><div class="table-grid">${tableCards}</div></section>
      </div><div class="stack">
        <section class="section"><div class="section-head"><h2>Cuenta del local</h2></div>
          <div class="billing"><span class="pill ${restaurant.subscriptionStatus === 'authorized' ? 'green' : ''}">${subscriptionLabel}</span><div>Plan ${restaurant.plan === 'ampliado' ? 'Ampliado' : 'Base'}</div><div class="billing-price">${money(price)}<span class="muted small"> / mes</span></div>
            <button class="btn secondary" id="connect-mp">${restaurant.mercadoPagoConnected ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'}</button>
            ${canStartSubscription ? '<button class="btn primary" id="subscribe">Activar suscripción</button>' : ''}
            ${canCancelSubscription ? '<button class="btn secondary" id="cancel-subscription">Cancelar suscripción</button>' : ''}
            <p class="muted small">Los pagos de pedidos van a la cuenta del café. La suscripción se cobra a la cuenta de Tably.</p>
          </div></section>
      </div></div>`;
    document.querySelector('#logout').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      renderAuth();
    });
    document.querySelector('#connect-mp').addEventListener('click', () => { location.href = '/api/mercadopago/connect'; });
    document.querySelector('#subscribe')?.addEventListener('click', async () => {
      try {
        const response = await api('/api/subscriptions/start', { method: 'POST', body: '{}' });
        location.href = response.checkoutUrl;
      } catch (error) { toast(error.message); }
    });
    document.querySelector('#cancel-subscription')?.addEventListener('click', async () => {
      if (!confirm('¿Querés cancelar la suscripción de este local?')) return;
      try { await api('/api/subscriptions/cancel', { method: 'POST', body: '{}' }); await renderDashboard(); }
      catch (error) { toast(error.message); }
    });
    bindMenuControls();
    bindOrderControls();
    dashboardOrdersSnapshot = JSON.stringify(orders);
    window.tablyDashboardPoll = setInterval(() => refreshDashboardOrders().catch(() => {}), 8000);
  } catch {
    stopDashboardPolling();
    renderAuth();
  }
}

async function renderMenu(slug) {
  const table = Number(new URLSearchParams(location.search).get('table'));
  const orderId = new URLSearchParams(location.search).get('order_id');
  topbarMeta.textContent = Number.isInteger(table) ? `Mesa ${table}` : '';
  if (orderId) return renderOrderStatus(orderId, slug, table);
  let menu;
  try { menu = await api(`/api/public/${encodeURIComponent(slug)}?table=${table}`); }
  catch (error) { app.innerHTML = `<section class="panel customer"><h2>No pudimos abrir el menú</h2><p class="muted">${esc(error.message)}</p></section>`; return; }
  const cart = new Map();
  const paymentStorageKey = `tably-payment:${slug}:${table}`;
  let selectedPayment;
  try { selectedPayment = sessionStorage.getItem(paymentStorageKey); } catch {}
  if (!['mercadopago', 'card', 'cash'].includes(selectedPayment)) selectedPayment = 'mercadopago';
  let screen = 'menu';
  const categories = [...new Set(menu.items.map((item) => item.category))];
  const menuHtml = categories.map((category) => `<section><div class="section-head"><h2>${esc(category)}</h2></div>
    ${menu.items.filter((item) => item.category === category).map((item) => `<article class="menu-item"><div><h3>${esc(item.name)}</h3><p>${esc(item.description)}</p><span class="money">${money(item.priceArs)}</span></div>
      <div class="stepper"><button aria-label="Quitar ${esc(item.name)}" data-remove="${item.id}">−</button><span data-count="${item.id}">0</span><button aria-label="Agregar ${esc(item.name)}" data-add="${item.id}">+</button></div></article>`).join('')}</section>`).join('');
  const cartItems = () => menu.items.filter((item) => cart.get(item.id) > 0).map((item) => ({ ...item, quantity: cart.get(item.id) }));
  const cartTotal = () => cartItems().reduce((sum, item) => sum + item.priceArs * item.quantity, 0);
  const cartCount = () => cartItems().reduce((sum, item) => sum + item.quantity, 0);

  function updateCart() {
    const dock = document.querySelector('#cart-dock');
    if (dock) dock.hidden = cartCount() === 0;
    const count = document.querySelector('#cart-count');
    if (count) count.textContent = `${cartCount()} ${cartCount() === 1 ? 'producto' : 'productos'}`;
    const total = document.querySelector('#cart-total');
    if (total) total.textContent = money(cartTotal());
    menu.items.forEach((item) => {
      const countLabel = document.querySelector(`[data-count="${item.id}"]`);
      if (countLabel) countLabel.textContent = cart.get(item.id) || 0;
    });
  }

  function renderMenuScreen() {
    screen = 'menu';
    app.innerHTML = `<section class="customer"><div class="customer-head"><span class="muted small">${esc(menu.restaurant.name)}</span><h1>Mesa ${menu.table}</h1><p class="muted">Elegí lo que te gustaría pedir.</p></div>
      <div class="menu-list">${menuHtml}</div>
      <div class="cart-dock" id="cart-dock" hidden><div><strong id="cart-count"></strong><span id="cart-total"></span></div><button class="btn primary" id="go-checkout">Pagar</button></div>
    </section>`;
    app.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.add;
      cart.set(id, Math.min(20, (cart.get(id) || 0) + 1));
      updateCart();
    }));
    app.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.remove;
      cart.set(id, Math.max(0, (cart.get(id) || 0) - 1));
      updateCart();
    }));
    document.querySelector('#go-checkout').addEventListener('click', openCheckout);
    updateCart();
  }

  function renderCheckoutScreen() {
    const items = cartItems();
    if (!items.length) return renderMenuScreen();
    screen = 'checkout';
    const total = cartTotal();
    app.innerHTML = `<section class="customer checkout-page">
      <button class="checkout-back" id="checkout-back" type="button">← Volver al menú</button>
      <div class="customer-head"><span class="muted small">${esc(menu.restaurant.name)} · Mesa ${menu.table}</span><h1>Resumen del pedido</h1></div>
      <div class="checkout-layout">
        <section class="ticket" aria-label="Ticket del pedido">
          <div class="ticket-heading"><strong>${esc(menu.restaurant.name)}</strong><span>Mesa ${menu.table}</span></div>
          <div class="ticket-lines">${items.map((item) => `<div class="ticket-line"><span><b>${item.quantity} ×</b> ${esc(item.name)}</span><strong>${money(item.priceArs * item.quantity)}</strong></div>`).join('')}</div>
          <div class="ticket-total"><span>Total</span><strong>${money(total)}</strong></div>
        </section>
        <section class="payment-panel" aria-label="Métodos de pago">
          <h2>Elegí cómo pagar</h2>
          <fieldset class="payment-options">
            <legend>Método de pago</legend>
            <label class="payment-option"><input type="radio" name="paymentMethod" value="mercadopago" ${selectedPayment === 'mercadopago' ? 'checked' : ''}><span><strong>Mercado Pago</strong><small>Al confirmarse el pago, el pedido se envía a cocina. Si volvés sin pagar, no se prepara.</small></span></label>
            <label class="payment-option"><input type="radio" name="paymentMethod" value="card" ${selectedPayment === 'card' ? 'checked' : ''}><span><strong>Tarjeta</strong><small>El personal se acerca a tu mesa con el posnet.</small></span></label>
            <label class="payment-option"><input type="radio" name="paymentMethod" value="cash" ${selectedPayment === 'cash' ? 'checked' : ''}><span><strong>Efectivo</strong><small>El personal se acerca a cobrarte a la mesa.</small></span></label>
          </fieldset>
          <button class="btn primary pay-confirm" id="place-order">Pagar ${money(total)}</button>
        </section>
      </div>
    </section>`;

    document.querySelector('#checkout-back').addEventListener('click', () => history.back());
    document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => radio.addEventListener('change', () => {
      selectedPayment = radio.value;
      try { sessionStorage.setItem(paymentStorageKey, selectedPayment); } catch {}
    }));
    document.querySelector('#place-order').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const label = button.textContent;
      busyButton(button, true, label);
      try {
        const order = await api(`/api/public/${encodeURIComponent(slug)}/orders`, {
          method: 'POST',
          body: JSON.stringify({ table, method: selectedPayment, items: items.map((item) => ({ id: item.id, quantity: item.quantity })) }),
        });
        cart.clear();
        if (order.checkoutUrl) location.href = order.checkoutUrl;
        else {
          const next = new URL(location.href);
          next.searchParams.set('order_id', order.id);
          history.replaceState({}, '', next);
          window.removeEventListener('popstate', handleCheckoutPopState);
          await renderOrderStatus(order.id, slug, table);
        }
      } catch (error) { toast(error.message); busyButton(button, false, label); }
    });
  }

  function openCheckout() {
    if (!cartCount()) return;
    history.pushState({ tablyCheckout: true }, '', location.href);
    renderCheckoutScreen();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handleCheckoutPopState() {
    if (screen === 'checkout') renderMenuScreen();
  }

  window.addEventListener('popstate', handleCheckoutPopState);
  renderMenuScreen();
}

async function renderOrderStatus(orderId, slug, table) {
  topbarMeta.textContent = `Mesa ${table || ''}`;
  let lastOrderSnapshot = '';
  const refresh = async () => {
    const order = await api(`/api/public/orders/${encodeURIComponent(orderId)}`);
    const isPaid = order.paymentStatus === 'approved';
    const statusText = { received: 'Recibido', preparing: 'Preparando', ready: 'Listo', delivered: 'Entregado' }[order.orderStatus] || 'Recibido';
    const snapshot = JSON.stringify(order);
    if (snapshot === lastOrderSnapshot) return isPaid && order.orderStatus === 'delivered';
    const waitingForMp = order.paymentMethod === 'mercadopago' && order.paymentStatus === 'pending';
    const rejectedPayment = order.paymentStatus === 'rejected';
    const orderHeading = order.paymentMethod !== 'mercadopago' && !isPaid
      ? 'El personal se acerca a tu mesa'
      : isPaid
        ? 'Tu pedido está en marcha'
        : rejectedPayment
          ? 'No se confirmó el pago'
          : 'Esperando confirmación de Mercado Pago';
    const headline = orderHeading;
    const message = isPaid
      ? statusText
      : rejectedPayment
        ? 'El pedido no se envió a cocina. Volvé al menú para realizar otro pedido.'
        : waitingForMp
          ? 'Si saliste de Mercado Pago antes de terminar, todavía no hay un pago confirmado. No enviaremos el pedido a cocina hasta recibir la confirmación segura de Mercado Pago.'
          : `El local recibió el aviso para cobrar ${money(order.totalArs)} en tu mesa.`;
    app.innerHTML = `<section class="panel customer status"><span class="pill ${isPaid ? 'green' : rejectedPayment ? 'collection-needed' : ''}">${isPaid ? statusText : rejectedPayment ? 'Pago rechazado' : 'Pedido registrado'}</span>
      <h2 style="margin-top:16px">${headline}</h2>
      <p class="muted">Mesa ${order.tableNumber} · Total ${money(order.totalArs)}</p>
      ${!isPaid ? `<p class="muted">${message}</p>` : ''}
      <div class="order-detail">${order.items.map((item) => `${item.quantity} × ${esc(item.name)}`).join('<br>')}</div>
      <a class="btn secondary" style="display:inline-flex;align-items:center;margin-top:22px;text-decoration:none" href="/menu/${encodeURIComponent(slug)}?table=${table}">Volver al menú</a></section>`;
    lastOrderSnapshot = snapshot;
    return isPaid && order.orderStatus === 'delivered';
  };
  try {
    await refresh();
    clearInterval(window.tablyOrderPoll);
    window.tablyOrderPoll = setInterval(async () => {
      try { if (await refresh()) clearInterval(window.tablyOrderPoll); } catch { clearInterval(window.tablyOrderPoll); }
    }, 5000);
  } catch (error) { app.innerHTML = `<section class="panel customer"><p>${esc(error.message)}</p></section>`; }
}

const path = location.pathname;
const route = path.match(/^\/menu\/([^/]+)\/?$/);
const mpResult = new URLSearchParams(location.search).get('mp');
if (route) renderMenu(decodeURIComponent(route[1]));
else if (mpResult === 'connected') renderDashboard().then(() => toast('Cuenta de Mercado Pago vinculada.'));
else if (mpResult === 'error') api('/api/auth/me').then(() => renderDashboard()).then(() => toast('No se completó la vinculación. Podés volver a intentarlo desde el panel.')).catch(() => renderAuth());
else api('/api/auth/me').then(renderDashboard).catch(() => renderAuth());