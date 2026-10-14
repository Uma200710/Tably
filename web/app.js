import { markExistingProducts, parseMenuFile } from './menu-importer.js';

const app = document.querySelector('#app');
const topbarMeta = document.querySelector('#topbar-meta');
const themeToggle = document.querySelector('#theme-toggle');
const money = (amount) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(amount);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let toastTimer;
let dashboardOrdersSnapshot = '';
let dashboardTablesSnapshot = '';
let dashboardOrdersRefresh = null;
let dashboardKnownOrderIds = new Set();
let dashboardAudioContext = null;
let dashboardSoundEnabled = false;
let dashboardDayCloseReport = null;
let dashboardRestaurantIsOpen = true;

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

function orderNeedsAttention(order) {
  return order.orderStatus === 'received' && ['pending', 'approved'].includes(order.paymentStatus);
}

function playOrderAlert() {
  if (!dashboardSoundEnabled || dashboardAudioContext?.state !== 'running') return;
  const context = dashboardAudioContext;
  const startAt = context.currentTime + 0.02;
  [880, 660, 880].forEach((frequency, index) => {
    const startsAt = startAt + index * 0.17;
    const oscillator = context.createOscillator();
    const volume = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    volume.gain.setValueAtTime(0.0001, startsAt);
    volume.gain.exponentialRampToValueAtTime(0.07, startsAt + 0.015);
    volume.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.15);
    oscillator.connect(volume);
    volume.connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.16);
  });
}

function updateOrderAttention(orders) {
  const attentionCount = orders.filter(orderNeedsAttention).length;
  const countBadge = document.querySelector('[data-order-attention-count]');
  if (countBadge) {
    countBadge.hidden = attentionCount === 0;
    countBadge.textContent = `${attentionCount} ${attentionCount === 1 ? 'pendiente' : 'pendientes'}`;
  }

  const banner = document.querySelector('#order-attention');
  if (banner) {
    const count = String(attentionCount);
    if (!attentionCount) {
      banner.hidden = true;
      banner.dataset.attentionCount = count;
      banner.replaceChildren();
    } else if (banner.dataset.attentionCount !== count) {
      banner.hidden = false;
      banner.dataset.attentionCount = count;
      banner.innerHTML = `<span class="order-attention-mark" aria-hidden="true">!</span><div><strong>${attentionCount} ${attentionCount === 1 ? 'pedido requiere' : 'pedidos requieren'} atención</strong><p>Confirmá el cobro si hace falta y pasá el pedido a preparación para quitarlo de pendientes.</p></div>`;
    }
  }

  document.title = attentionCount ? `(${attentionCount}) Pedidos pendientes · Tably` : 'Tably · Pedidos y mesas';
}

function bindOrderAlertControls() {
  const button = document.querySelector('#order-sound-toggle');
  const status = document.querySelector('#order-sound-status');
  if (!button || button.dataset.bound === 'true') return;
  button.dataset.bound = 'true';
  button.setAttribute('aria-pressed', String(dashboardSoundEnabled));
  button.textContent = dashboardSoundEnabled ? 'Silenciar sonido' : 'Activar sonido';

  button.addEventListener('click', async () => {
    if (dashboardSoundEnabled) {
      dashboardSoundEnabled = false;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = 'Activar sonido';
      status.textContent = 'Avisos sonoros desactivados.';
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      status.textContent = 'Este navegador no permite avisos sonoros.';
      return;
    }
    try {
      dashboardAudioContext ||= new AudioContextClass();
      await dashboardAudioContext.resume();
      if (dashboardAudioContext.state !== 'running') throw new Error('No se pudo iniciar el audio.');
      dashboardSoundEnabled = true;
      button.setAttribute('aria-pressed', 'true');
      button.textContent = 'Silenciar sonido';
      status.textContent = 'El aviso sonará cuando llegue un pedido nuevo.';
    } catch {
      status.textContent = 'No se pudo activar el sonido. Revisá los permisos del navegador.';
    }
  });
}

function dayCloseSummaryHtml(report) {
  if (!report) return '<div class="empty">No se pudo cargar el cierre del día. Actualizá el resumen para volver a intentarlo.</div>';
  const [year, month, day] = report.date.split('-').map(Number);
  const businessDate = new Date(Date.UTC(year, month - 1, day, 15));
  const dateLabel = new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'full',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(businessDate);
  const amount = (value) => money(Number(value) || 0);
  const closedAt = report.closedAt
    ? new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(report.closedAt))
    : null;
  return `<p class="day-close-date">${esc(dateLabel)} · Hora de Argentina</p>
    ${report.isClosed ? `<p class="day-close-closed"><span class="pill disabled">Día cerrado</span><span>Registrado el ${esc(closedAt || 'hoy')} · Los importes quedaron guardados.</span></p>` : ''}
    <div class="day-close-grid">
      <article class="day-close-stat featured"><span>Ventas cobradas</span><strong>${amount(report.paidTotalArs)}</strong><small>${report.paidCount} pedidos con cobro confirmado</small></article>
      <article class="day-close-stat"><span>Cobros pendientes</span><strong>${amount(report.pendingTotalArs)}</strong><small>${report.pendingCount} pedidos por cobrar</small></article>
      <article class="day-close-stat"><span>Pedidos registrados</span><strong>${report.ordersCount}</strong><small>${report.cancelledCount} cancelados</small></article>
    </div>
    <section class="day-close-methods"><h3>Cobros confirmados por medio</h3>
      <div><span>Efectivo</span><strong>${amount(report.cashTotalArs)}</strong></div>
      <div><span>Tarjeta o transferencias</span><strong>${amount(Number(report.cardTotalArs) + Number(report.mercadoPagoTotalArs))}</strong></div>
    </section>
    <p class="muted small day-close-note">${report.isClosed ? 'Este cierre quedó registrado y los pedidos por QR permanecen detenidos hasta mañana.' : 'El resumen incluye los pedidos creados hoy. Las ventas cuentan solo cobros confirmados; los pendientes se muestran aparte.'}</p>`;
}

function updateDayCloseControls(report) {
  const status = document.querySelector('#day-close-status');
  if (status) {
    status.className = `pill ${report.isClosed ? 'disabled' : 'green'}`;
    status.textContent = report.isClosed ? 'Día cerrado' : 'Día abierto';
  }
  const button = document.querySelector('#close-day');
  if (button) {
    button.disabled = report.isClosed;
    button.textContent = report.isClosed ? 'Día cerrado' : 'Cerrar el día';
  }
  const downloadButton = document.querySelector('#download-day-close');
  if (downloadButton) {
    downloadButton.disabled = false;
    downloadButton.textContent = report.isClosed ? 'Descargar cierre CSV' : 'Descargar resumen CSV';
  }
  updateRestaurantServiceStatus(report.isClosed ? false : dashboardRestaurantIsOpen, report.isClosed);
}

async function refreshDayCloseReport() {
  const report = await api('/api/admin/day-close');
  dashboardDayCloseReport = report;
  const summary = document.querySelector('#day-close-summary');
  if (summary) summary.innerHTML = dayCloseSummaryHtml(report);
  updateDayCloseControls(report);
  return report;
}

function downloadDayCloseReport() {
  if (!dashboardDayCloseReport) return;
  const report = dashboardDayCloseReport;
  const rows = [
    ['Cierre del día', report.date],
    ['Pedidos registrados', report.ordersCount],
    ['Pedidos cobrados', report.paidCount],
    ['Ventas cobradas ARS', report.paidTotalArs],
    ['Pedidos por cobrar', report.pendingCount],
    ['Cobros pendientes ARS', report.pendingTotalArs],
    ['Efectivo cobrado ARS', report.cashTotalArs],
    ['Tarjeta o transferencias cobradas ARS', Number(report.cardTotalArs) + Number(report.mercadoPagoTotalArs)],
    ['Pedidos cancelados', report.cancelledCount],
    ['Estado del día', report.isClosed ? 'Cerrado' : 'Abierto'],
    ...(report.closedAt ? [['Cierre registrado', report.closedAt]] : []),
  ];
  const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const csv = rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const file = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cierre-tably-${report.date}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindDayCloseControls() {
  document.querySelector('#refresh-day-close')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshDayCloseReport();
      toast('Cierre del día actualizado.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector('#download-day-close')?.addEventListener('click', downloadDayCloseReport);
  document.querySelector('#close-day')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const pendingNote = dashboardDayCloseReport?.pendingCount
      ? ` Hay ${dashboardDayCloseReport.pendingCount} cobros pendientes; quedarán registrados por separado.`
      : '';
    if (!await confirmAction(`Al cerrar el día se guardará este resumen, el local dejará de aceptar pedidos por QR y podrás volver a abrirlo mañana.${pendingNote} ¿Querés continuar?`)) return;
    button.disabled = true;
    try {
      const report = await api('/api/admin/day-close', { method: 'POST', body: '{}' });
      dashboardDayCloseReport = report;
      dashboardRestaurantIsOpen = false;
      const summary = document.querySelector('#day-close-summary');
      if (summary) summary.innerHTML = dayCloseSummaryHtml(report);
      updateDayCloseControls(report);
      toast('Día cerrado. El resumen quedó guardado y los pedidos por QR están detenidos.');
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  });
}

function updateRestaurantServiceStatus(isOpen, dayClosed = false) {
  const label = document.querySelector('#service-status-label');
  const description = document.querySelector('#service-status-description');
  const button = document.querySelector('#service-toggle');
  if (!label || !description || !button) return;
  label.className = `pill ${isOpen ? 'green' : 'disabled'}`;
  label.textContent = isOpen ? 'Local abierto' : 'Local cerrado';
  description.textContent = dayClosed
    ? 'El d\u00eda ya fue cerrado. Podr\u00e1s abrir el local ma\u00f1ana.'
    : isOpen
      ? 'Los QR aceptan pedidos. El panel sigue disponible.'
      : 'Los QR muestran un aviso y no aceptan pedidos. Pod\u00e9s reabrir el local desde aqu\u00ed.';
  button.className = `btn small-btn ${isOpen || dayClosed ? 'secondary' : 'green'}`;
  button.disabled = dayClosed;
  button.dataset.isOpen = String(isOpen);
  button.setAttribute('aria-pressed', String(isOpen));
  button.textContent = dayClosed ? 'D\u00eda cerrado' : isOpen ? 'Cerrar local' : 'Abrir local';
}

function bindRestaurantServiceStatus() {
  const button = document.querySelector('#service-toggle');
  button?.addEventListener('click', async () => {
    const isOpen = button.dataset.isOpen === 'true';
    if (isOpen && !await confirmAction('Al cerrar el local, los clientes ya no podrán enviar pedidos por QR. El panel seguirá disponible para que consultes los pedidos y el cierre del día. ¿Querés continuar?')) return;
    button.disabled = true;
    try {
      const result = await api('/api/admin/service', {
        method: 'PATCH',
        body: JSON.stringify({ isOpen: !isOpen }),
      });
      dashboardRestaurantIsOpen = result.isOpen;
      updateRestaurantServiceStatus(result.isOpen);
      toast(result.isOpen ? 'El local está abierto y acepta pedidos.' : 'El local está cerrado. No se aceptan pedidos por QR.');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function confirmAction(message) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    const text = document.createElement('p');
    text.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn secondary';
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    const confirm = document.createElement('button');
    confirm.className = 'btn primary';
    confirm.type = 'button';
    confirm.textContent = 'Confirmar';
    actions.append(cancel, confirm);
    dialog.append(text, actions);
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      dialog.remove();
    }, { once: true });
    cancel.addEventListener('click', () => dialog.close('cancel'));
    confirm.addEventListener('click', () => dialog.close('confirm'));
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close('cancel');
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'No se pudo completar la operación.');
    error.code = body.code;
    throw error;
  }
  return body;
}

function busyButton(button, busy, label) {
  button.disabled = busy;
  button.textContent = busy ? 'Un momento…' : label;
}

function renderAuth(showRegister = false) {
  stopDashboardPolling();
  document.title = 'Tably · Pedidos y mesas';
  dashboardSoundEnabled = false;
  dashboardKnownOrderIds = new Set();
  dashboardDayCloseReport = null;
  if (dashboardAudioContext) {
    void dashboardAudioContext.close().catch(() => {});
    dashboardAudioContext = null;
  }
  topbarMeta.textContent = 'Pedidos y mesas en orden';
  app.innerHTML = `<div class="auth-wrap">
    <section class="intro"><div class="intro-mark">Gestión para cafeterías</div>
      <h1>Pedidos y mesas, en un solo lugar.</h1>
      <p>Administrá el menú, recibí pedidos y registrá los cobros de tu local.</p>
    </section>
    <section class="panel" aria-label="Acceso al local">
      <h2>${showRegister ? 'Crear cuenta para tu café' : 'Iniciar sesión'}</h2>
      <p class="muted small">${showRegister ? 'Empezá con tu menú y tus mesas. El personal cobra cada pedido en la mesa.' : 'Gestioná pedidos, mesas y cobros.'}</p>
      <form class="form" id="auth-form" accept-charset="UTF-8">
        ${showRegister ? `<div class="field"><label for="cafe-name">Nombre del café</label><input id="cafe-name" name="name" required minlength="2" maxlength="80" autocomplete="organization"></div>` : ''}
        <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="email"></div>
        <div class="field"><label for="password">Contraseña</label><input id="password" name="password" type="password" required minlength="${showRegister ? '10' : '1'}" autocomplete="${showRegister ? 'new-password' : 'current-password'}"></div>
        ${showRegister ? `<div class="field"><label for="table-count">Cantidad de mesas</label><input id="table-count" name="tableCount" type="number" min="1" max="200" value="10" required><span class="muted small">Hasta 15 mesas: Base · Más de 15: Ampliado</span></div>` : ''}
        <button class="btn primary" type="submit">${showRegister ? 'Crear cuenta' : 'Iniciar sesión'}</button>
      </form>
      <div class="switch">${showRegister ? '¿Ya tenés cuenta?' : '¿Todavía no tenés cuenta?'} <button class="text-btn" id="auth-switch">${showRegister ? 'Iniciar sesión' : 'Crear cuenta'}</button></div>
    </section>
  </div>`;
  document.querySelector('#auth-switch').addEventListener('click', () => renderAuth(!showRegister));
  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const label = showRegister ? 'Crear cuenta' : 'Iniciar sesión';
    busyButton(button, true, label);
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (showRegister) {
      data.name = data.name.normalize('NFC');
      data.tableCount = Number(data.tableCount);
    }
    try {
      await api(`/api/auth/${showRegister ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(data) });
      await renderDashboard();
    } catch (error) {
      toast(error.message);
      busyButton(button, false, label);
    }
  });
}

function orderCard(order) {
  const items = order.items.map((item) => `${item.quantity} × ${esc(item.name)}`).join(', ');
  const payment = order.paymentMethod === 'cash' ? 'Efectivo' : 'Tarjeta o transferencias';
  const needsAttention = orderNeedsAttention(order);
  const actions = [];
  if (order.paymentStatus === 'pending') {
    actions.push(`<button class="btn green small-btn" data-collect-paid="${order.id}">Confirmar cobro</button>`);
  }
  const next = { received: 'preparing', preparing: 'ready', ready: 'delivered' }[order.orderStatus];
  if (order.paymentStatus === 'approved' && next) {
    actions.push(`<button class="btn secondary small-btn" data-next-status="${order.id}" data-status="${next}">Pasar a ${next === 'preparing' ? 'preparando' : next === 'ready' ? 'listo' : 'entregado'}</button>`);
  }
  const waitingForCollection = order.paymentStatus === 'pending';
  return `<article class="order ${needsAttention ? 'needs-attention' : ''}"><div>${waitingForCollection ? `<span class="pill collection-needed">Acercarse a mesa ${order.tableNumber} · cobrar ${payment}</span>` : ''}<strong>Mesa ${order.tableNumber} · ${money(order.totalArs)}</strong>
    ${needsAttention ? '<span class="pill order-attention-badge">Pendiente de atención</span>' : ''}
    <div class="order-detail">${items}<br>${payment} · ${order.paymentStatus === 'approved' ? 'Pagado' : 'Pendiente'} · ${order.orderStatus}</div></div>
    <div class="order-actions">${actions.join('')}</div></article>`;
}

function orderListHtml(orders) {
  const groups = [
    ['Cobros en mesa', orders.filter((order) => order.paymentStatus === 'pending'), 'No hay mesas esperando el cobro del personal.'],
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
      <button class="menu-delete" type="button" data-menu-delete="${item.id}" aria-label="Eliminar ${esc(item.name)} del menú" title="Eliminar del menú"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3M3 7h18"/></svg><span>Eliminar</span></button></div>
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
    if (!await confirmAction('¿Eliminar este producto definitivamente? Los pedidos anteriores conservarán su información.')) return;
    button.disabled = true;
    try {
      await api(`/api/admin/menu/${form.dataset.menuId}`, { method: 'DELETE' });
      form.remove();
      syncMenuSaveAll();
      toast('Producto eliminado. Los pedidos anteriores se conservaron.');
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

function showMenuImportPreview(products, fileName, method, quality = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'menu-import-dialog';
  const selectedCount = products.filter((item) => item.selected).length;
  dialog.innerHTML = `<div class="import-dialog-head"><div><span class="muted small">${esc(method)} · <span data-import-count>${products.length}</span> productos detectados</span><h2>Revisá el menú</h2></div><button class="dialog-close" type="button" aria-label="Cerrar">×</button></div>
    <p class="import-privacy">${esc(fileName)}. El archivo se analizó en este dispositivo. Solo se guardan los productos que confirmes.</p>
    <p class="import-quality" data-import-quality hidden></p>
    <div class="import-toolbar"><label><input type="checkbox" id="import-select-all" ${selectedCount === products.filter((item) => !item.duplicate).length ? 'checked' : ''}> Seleccionar todos los productos nuevos</label><span class="muted small" id="import-selection-count">${selectedCount} seleccionados</span></div>
    <div class="import-table-wrap"><table class="import-table"><thead><tr><th>Agregar</th><th>Categoría</th><th>Producto</th><th>Descripción</th><th>Precio (ARS)</th><th>Quitar</th></tr></thead>
      <tbody>${products.map((item, index) => `<tr data-import-row="${index}" class="${item.duplicate ? 'is-duplicate' : ''} ${item.needsReview && !item.duplicate ? 'needs-review' : ''}">
        <td><input type="checkbox" data-import-select ${item.selected ? 'checked' : ''} ${item.duplicate ? 'disabled' : ''} aria-label="${item.duplicate ? 'Ya existe en el menú' : 'Importar producto'}"></td>
        <td><input data-import-field="category" value="${esc(item.category)}" maxlength="40" aria-label="Categoría" ${item.duplicate ? 'disabled' : ''}></td>
        <td><input data-import-field="name" value="${esc(item.name)}" maxlength="100" aria-label="Producto" ${item.duplicate ? 'disabled' : ''}><small>${item.duplicate ? 'Ya existe en el menú; se omitirá.' : item.needsReview ? `Lectura dudosa (${item.confidence ?? 0} %). Corrige nombre y precio antes de agregar.` : item.confidence != null ? `Lectura clara · ${item.confidence} %` : ''}</small></td>
        <td><input data-import-field="description" value="${esc(item.description)}" maxlength="240" aria-label="Descripción" ${item.duplicate ? 'disabled' : ''}></td>
        <td><input data-import-field="priceArs" type="number" min="1" step="1" value="${item.priceArs}" aria-label="Precio" ${item.duplicate ? 'disabled' : ''}></td>
        <td><button class="import-remove" type="button" data-remove-import aria-label="Quitar ${esc(item.name)} de esta importación">Quitar</button></td>
      </tr>`).join('')}</tbody></table></div>
    <div class="import-dialog-actions"><button class="btn secondary" type="button" data-import-cancel>Cancelar</button><button class="btn primary" type="button" data-import-save>${selectedCount ? `Importar ${selectedCount} productos` : 'Importar productos'}</button></div>`;
  document.body.append(dialog);

  const selectAll = dialog.querySelector('#import-select-all');
  const selectionCount = dialog.querySelector('#import-selection-count');
  const saveButton = dialog.querySelector('[data-import-save]');
  const qualityNotice = dialog.querySelector('[data-import-quality]');
  const refreshSelection = () => {
    const rows = dialog.querySelectorAll('[data-import-row]');
    const count = dialog.querySelectorAll('[data-import-select]:checked:not(:disabled)').length;
    const reviewCount = [...rows].filter((row) => row.classList.contains('needs-review') && !row.classList.contains('is-duplicate')).length;
    const qualityNotes = [];
    if (reviewCount) qualityNotes.push(`${reviewCount} ${reviewCount === 1 ? 'lectura requiere' : 'lecturas requieren'} revisión; ${reviewCount === 1 ? 'se dejó' : 'se dejaron'} sin seleccionar.`);
    if (quality.skippedPriceLines) qualityNotes.push(`Se descartaron ${quality.skippedPriceLines} ${quality.skippedPriceLines === 1 ? 'cifra o línea' : 'cifras o líneas'} que no se pudieron asociar con seguridad.`);
    dialog.querySelector('[data-import-count]').textContent = rows.length;
    qualityNotice.hidden = qualityNotes.length === 0;
    qualityNotice.textContent = qualityNotes.join(' ');
    selectionCount.textContent = `${count} seleccionados`;
    saveButton.textContent = count ? `Importar ${count} productos` : 'Importar productos';
    saveButton.disabled = count === 0;
    const eligible = [...dialog.querySelectorAll('[data-import-select]:not(:disabled)')];
    selectAll.checked = eligible.length > 0 && eligible.every((checkbox) => checkbox.checked);
    selectAll.indeterminate = !selectAll.checked && eligible.some((checkbox) => checkbox.checked);
  };

  dialog.querySelectorAll('[data-import-select]').forEach((checkbox) => checkbox.addEventListener('change', refreshSelection));
  dialog.querySelectorAll('[data-remove-import]').forEach((button) => button.addEventListener('click', () => {
    button.closest('[data-import-row]').remove();
    refreshSelection();
  }));
  selectAll.addEventListener('change', () => {
    dialog.querySelectorAll('[data-import-select]:not(:disabled)').forEach((checkbox) => { checkbox.checked = selectAll.checked; });
    refreshSelection();
  });
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-import-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  refreshSelection();
  dialog.showModal();

  saveButton.addEventListener('click', async () => {
    const selected = [...dialog.querySelectorAll('[data-import-row]')]
      .filter((row) => row.querySelector('[data-import-select]').checked)
      .map((row) => ({
        category: row.querySelector('[data-import-field="category"]').value.trim(),
        name: row.querySelector('[data-import-field="name"]').value.trim(),
        description: row.querySelector('[data-import-field="description"]').value.trim(),
        priceArs: Number(row.querySelector('[data-import-field="priceArs"]').value),
      }));
    if (!selected.length) return;
    saveButton.disabled = true;
    saveButton.textContent = 'Guardando…';
    let result;
    try {
      result = await api('/api/admin/menu/import', { method: 'POST', body: JSON.stringify({ items: selected }) });
    } catch (error) {
      saveButton.disabled = false;
      saveButton.textContent = `Importar ${selected.length} productos`;
      toast(error.message);
      return;
    }

    const importedCount = result.imported ?? selected.length;
    dialog.close();
    const status = document.querySelector('#menu-import-status');
    if (status) status.textContent = `Menú guardado: ${importedCount} productos agregados.`;
    const list = document.querySelector('#menu-admin');
    if (list && Array.isArray(result.items)) {
      list.insertAdjacentHTML('beforeend', result.items.map(menuItemHtml).join(''));
      list.querySelectorAll('.menu-edit:not([data-bound="true"])').forEach(bindMenuEditForm);
      syncMenuSaveAll();
    }
    toast(`Menú guardado: se agregaron ${importedCount} productos.`);
  });
}

function bindMenuImport() {
  const fileInput = document.querySelector('#menu-import-file');
  const trigger = document.querySelector('#menu-import-trigger');
  const status = document.querySelector('#menu-import-status');
  trigger.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    trigger.disabled = true;
    status.textContent = 'Analizando el archivo…';
    try {
      const { products, method, quality } = await parseMenuFile(file, (message) => { status.textContent = message; });
      const existing = await api('/api/admin/menu');
      const prepared = markExistingProducts(products, existing);
      status.textContent = `${prepared.length} productos listos para revisar.`;
      showMenuImportPreview(prepared, file.name, method, quality);
    } catch (error) {
      status.textContent = 'No se pudo leer el archivo.';
      toast(error.message);
    } finally {
      trigger.disabled = false;
      fileInput.value = '';
    }
  });
}

function bindOrderControls() {
  document.querySelectorAll('[data-collect-paid]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/orders/${button.dataset.collectPaid}/collect-payment`, { method: 'POST', body: '{}' });
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

function updateTableOccupancy(tables) {
  let occupied = 0;
  for (const table of tables) {
    const card = document.querySelector(`[data-table-card="${table.table}"]`);
    if (!card) continue;
    const badge = card.querySelector('[data-table-status]');
    const clearButton = card.querySelector('[data-clear-table]');
    badge.textContent = table.occupied ? 'Ocupada' : 'Libre';
    badge.classList.toggle('green', !table.occupied);
    badge.classList.toggle('occupied', table.occupied);
    clearButton.hidden = !table.occupied;
    clearButton.disabled = false;
    if (table.occupied) occupied += 1;
  }
  const count = document.querySelector('[data-tables-count]');
  if (count) count.textContent = `${occupied} ocupadas`;
}

function bindTableControls() {
  document.querySelectorAll('[data-clear-table]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/tables/${button.dataset.clearTable}/clear`, { method: 'POST', body: '{}' });
      await refreshDashboardOrders();
    } catch (error) { button.disabled = false; toast(error.message); }
  }));
}

function setDashboardTab(tab) {
  document.querySelectorAll('[data-dashboard-tab]').forEach((button) => {
    const active = button.dataset.dashboardTab === tab;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-dashboard-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.dashboardPanel !== tab;
  });
  try { localStorage.setItem('tably-dashboard-tab', tab); } catch {}
}

async function refreshDashboardOrders() {
  if (dashboardOrdersRefresh) await dashboardOrdersRefresh;
  const list = document.querySelector('#orders-list');
  if (!list || document.hidden) return;

  const refresh = (async () => {
    const [orders, tables] = await Promise.all([api('/api/admin/orders'), api('/api/admin/tables')]);
    const newOrders = orders.filter((order) => orderNeedsAttention(order) && !dashboardKnownOrderIds.has(order.id));
    orders.forEach((order) => dashboardKnownOrderIds.add(order.id));
    const snapshot = JSON.stringify(orders);
    if (snapshot !== dashboardOrdersSnapshot) {
      const scrollY = window.scrollY;
      const focusedButton = list.contains(document.activeElement) ? document.activeElement : null;
      const focusedAction = focusedButton?.dataset.collectPaid
        ? ['collectPaid', focusedButton.dataset.collectPaid]
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
      refreshDayCloseReport().catch(() => {});
    }
    updateOrderAttention(orders);
    if (newOrders.length) {
      playOrderAlert();
      toast(newOrders.length === 1 ? 'Llegó un pedido nuevo. Revisá la pestaña Pedidos.' : `Llegaron ${newOrders.length} pedidos nuevos. Revisá la pestaña Pedidos.`);
    }
    const tablesSnapshot = JSON.stringify(tables.map(({ table, occupied, occupiedAt }) => ({ table, occupied, occupiedAt })));
    if (tablesSnapshot !== dashboardTablesSnapshot) {
      dashboardTablesSnapshot = tablesSnapshot;
      updateTableOccupancy(tables);
    }
  })();

  dashboardOrdersRefresh = refresh;
  try { await refresh; }
  finally { if (dashboardOrdersRefresh === refresh) dashboardOrdersRefresh = null; }
}

async function renderDashboard() {
  stopDashboardPolling();
  app.innerHTML = '<div class="loading">Cargando tu local…</div>';
  try {
    const [restaurant, orders, tables, menu, dayCloseReport] = await Promise.all([
      api('/api/auth/me'), api('/api/admin/orders'), api('/api/admin/tables'), api('/api/admin/menu'),
      api('/api/admin/day-close').catch(() => null),
    ]);
    dashboardDayCloseReport = dayCloseReport;
    dashboardRestaurantIsOpen = restaurant.isOpen !== false;
    topbarMeta.innerHTML = `${esc(restaurant.name)} <button class="text-btn" id="logout">Salir</button>`;
    const price = restaurant.tableCount > 15 ? 45000 : 30000;
    const subscriptionLabels = { trial: 'Prueba inicial', pending: 'Pago pendiente', authorized: 'Activa', cancelled: 'Cancelada', paused: 'Pausada' };
    const subscriptionLabel = subscriptionLabels[restaurant.subscriptionStatus] || 'Sin suscripción';
    const dueDate = new Date(restaurant.subscriptionDueAt);
    const dueDateText = new Intl.DateTimeFormat('es-AR', { dateStyle: 'long' }).format(dueDate);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dueDay = new Date(dueDate); dueDay.setHours(0, 0, 0, 0);
    const daysUntilDue = Math.ceil((dueDay - today) / 86_400_000);
    const subscriptionOverdue = ['trial', 'pending', 'authorized'].includes(restaurant.subscriptionStatus) && daysUntilDue < 0;
    const subscriptionReminder = restaurant.subscriptionStatus === 'trial'
      ? daysUntilDue >= 0
        ? `El período de prueba finaliza el ${dueDateText}. Para continuar, se requiere una suscripción activa.`
        : `El período de prueba finalizó el ${dueDateText}. El acceso continuará una vez verificado el pago de la suscripción.`
      : restaurant.subscriptionStatus === 'authorized'
        ? daysUntilDue < 0
          ? `La suscripción venció el ${dueDateText}. El acceso continuará una vez verificado el pago.`
          : daysUntilDue <= 7
            ? `La suscripción vence el ${dueDateText}. Revisá el estado del pago para mantener el servicio activo.`
            : `Vencimiento de la suscripción: ${dueDateText}.`
        : restaurant.subscriptionStatus === 'pending'
          ? `El pago está pendiente de verificación. El servicio se activará una vez confirmado.`
          : `El estado del servicio se actualizará una vez verificado el pago. Vencimiento: ${dueDateText}.`;
    const tableCards = tables.map((table) => `<article class="table" data-table-card="${table.table}">
      <div class="table-actions"><b>Mesa ${table.table}</b><span class="pill ${table.occupied ? 'occupied' : 'green'}" data-table-status>${table.occupied ? 'Ocupada' : 'Libre'}</span></div>
      <img src="${esc(table.qrUrl)}" alt="QR para la mesa ${table.table}" loading="lazy">
      <a href="${esc(table.url)}" target="_blank" rel="noreferrer">Abrir QR de mesa</a>
      <button class="btn secondary small-btn table-clear" type="button" data-clear-table="${table.table}" aria-label="Desocupar mesa ${table.table}" ${table.occupied ? '' : 'hidden'}>Desocupar mesa</button>
    </article>`).join('');
    const occupiedTables = tables.filter((table) => table.occupied).length;
    app.innerHTML = `<div class="heading-row"><div><h1>Panel del local</h1><p>${esc(restaurant.name)} · ${restaurant.tableCount} mesas · <a href="/menu/${esc(restaurant.slug)}?table=1" target="_blank" rel="noreferrer">Abrir menú</a></p></div></div>
      <section class="service-status-bar"><div class="service-status-info"><span class="pill ${restaurant.isOpen === false ? 'disabled' : 'green'}" id="service-status-label" aria-live="polite">${restaurant.isOpen === false ? 'Local cerrado' : 'Local abierto'}</span><div><strong>Pedidos por QR</strong><p id="service-status-description" class="muted small">${restaurant.isOpen === false ? 'Los QR muestran un aviso y no aceptan pedidos. Podés reabrir el local desde aquí.' : 'Los QR aceptan pedidos. El panel sigue disponible.'}</p></div></div><button class="btn small-btn ${restaurant.isOpen === false ? 'green' : 'secondary'}" id="service-toggle" type="button" data-is-open="${restaurant.isOpen !== false}" aria-pressed="${restaurant.isOpen !== false}">${restaurant.isOpen === false ? 'Abrir local' : 'Cerrar local'}</button></section>
      <nav class="dashboard-tabs" role="tablist" aria-label="Secciones del local">
        <button class="dashboard-tab" type="button" role="tab" id="tab-menu" aria-controls="panel-menu" data-dashboard-tab="menu"><span>Menú</span><span class="tab-count">${menu.length}</span></button>
        <button class="dashboard-tab" type="button" role="tab" id="tab-orders" aria-controls="panel-orders" data-dashboard-tab="orders"><span>Pedidos</span><span class="tab-count" data-orders-count>${orders.length}</span><span class="tab-attention-count" data-order-attention-count hidden></span></button>
        <button class="dashboard-tab" type="button" role="tab" id="tab-day-close" aria-controls="panel-day-close" data-dashboard-tab="day-close"><span>Cierre del día</span></button>
        <button class="dashboard-tab" type="button" role="tab" id="tab-tables" aria-controls="panel-tables" data-dashboard-tab="tables"><span>Mesas</span><span class="tab-count" data-tables-count>${occupiedTables} ocupadas</span></button>
      </nav>
      <div class="dashboard-panels">
        <section class="dashboard-tab-panel" id="panel-menu" role="tabpanel" aria-labelledby="tab-menu" data-dashboard-panel="menu">
          <section class="section"><div class="section-head"><div><h2>Menú</h2><span class="muted small">Productos y precios del local</span></div><a class="text-btn small" href="/menu/${esc(restaurant.slug)}?table=1" target="_blank" rel="noreferrer">Vista de cliente</a></div>
            <div class="menu-import">
              <div><strong>Importar menú desde archivo</strong><p class="muted small">Escanea tu menú. Admite fotos, PDF, Word, Excel, CSV/TSV, texto o JSON.</p></div>
              <input id="menu-import-file" type="file" accept=".png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.pdf,.docx,.xlsx,.xls,.xlsm,.ods,.csv,.tsv,.txt,.rtf,.json" hidden>
              <button class="btn secondary small-btn" id="menu-import-trigger" type="button">Elegir archivo</button>
              <span class="muted small" id="menu-import-status" aria-live="polite"></span>
            </div>
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
        </section>
        <section class="dashboard-tab-panel" id="panel-orders" role="tabpanel" aria-labelledby="tab-orders" data-dashboard-panel="orders" hidden>
          <section class="section"><div class="section-head orders-head"><div><h2>Pedidos y cobros</h2><span class="muted small">Actualización automática</span></div><div class="order-alert-controls"><button class="btn secondary small-btn" type="button" id="order-sound-toggle" aria-pressed="false">Activar sonido</button><span class="muted small" id="order-sound-status" aria-live="polite">El sonido está desactivado.</span></div></div>
            <div class="order-attention" id="order-attention" role="status" aria-live="polite" aria-atomic="true" hidden></div>
            <div class="orders" id="orders-list">${orderListHtml(orders)}</div></section>
        </section>
        <section class="dashboard-tab-panel" id="panel-day-close" role="tabpanel" aria-labelledby="tab-day-close" data-dashboard-panel="day-close" hidden>
          <section class="section"><div class="section-head day-close-head"><div><h2>Cierre del día</h2><span class="muted small">Resumen de ventas y cobros de hoy</span></div><div class="day-close-actions"><span class="pill ${dayCloseReport ? dayCloseReport.isClosed ? 'disabled' : 'green' : ''}" id="day-close-status" role="status">${dayCloseReport ? dayCloseReport.isClosed ? 'Día cerrado' : 'Día abierto' : 'Estado no disponible'}</span><button class="btn secondary small-btn" type="button" id="refresh-day-close">Actualizar</button><button class="btn primary small-btn" type="button" id="download-day-close" ${dayCloseReport ? '' : 'disabled'}>${dayCloseReport?.isClosed ? 'Descargar cierre CSV' : 'Descargar resumen CSV'}</button><button class="btn secondary small-btn" type="button" id="close-day" ${dayCloseReport && !dayCloseReport.isClosed ? '' : 'disabled'}>${dayCloseReport?.isClosed ? 'Día cerrado' : 'Cerrar el día'}</button></div></div>
            <div id="day-close-summary">${dayCloseSummaryHtml(dayCloseReport)}</div></section>
        </section>
        <section class="dashboard-tab-panel" id="panel-tables" role="tabpanel" aria-labelledby="tab-tables" data-dashboard-panel="tables" hidden>
          <section class="section"><div class="section-head"><div><h2>Mesas</h2><span class="muted small">Una mesa se ocupa con el primer pedido y se libera desde aquí.</span></div></div><div class="table-grid">${tableCards}</div></section>
        </section>
      </div>
      <section class="section account-summary"><div class="section-head"><h2>Cuenta del local</h2></div>
        <div class="billing"><span class="pill ${restaurant.subscriptionStatus === 'authorized' ? 'green' : ''}">${subscriptionLabel}</span><div>Plan ${restaurant.plan === 'ampliado' ? 'Ampliado' : 'Base'}</div><div class="billing-price">${money(price)}<span class="muted small"> / mes</span></div>
          <p class="billing-reminder ${subscriptionOverdue ? 'overdue' : ''}">${esc(subscriptionReminder)}</p>
          <p class="muted small">La activación y renovación del plan requieren la verificación del pago. Este aviso aparece al ingresar al panel.</p>
        </div>
      </section>`;
    document.querySelector('#logout').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      renderAuth();
    });
    document.querySelectorAll('[data-dashboard-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        setDashboardTab(button.dataset.dashboardTab);
        if (button.dataset.dashboardTab === 'day-close') refreshDayCloseReport().catch(() => {});
      });
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...document.querySelectorAll('[data-dashboard-tab]')];
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        const target = buttons[(buttons.indexOf(button) + direction + buttons.length) % buttons.length];
        target.focus();
        target.click();
      });
    });
    let initialTab = 'orders';
    try {
      const savedTab = localStorage.getItem('tably-dashboard-tab');
      if (['menu', 'orders', 'day-close', 'tables'].includes(savedTab)) initialTab = savedTab;
    } catch {}
    setDashboardTab(initialTab);
    updateRestaurantServiceStatus(restaurant.isOpen !== false, dayCloseReport?.isClosed === true);
    if (dayCloseReport) updateDayCloseControls(dayCloseReport);
    bindRestaurantServiceStatus();
    bindMenuControls();
    bindMenuImport();
    bindDayCloseControls();
    bindOrderAlertControls();
    bindOrderControls();
    bindTableControls();
    dashboardOrdersSnapshot = JSON.stringify(orders);
    dashboardKnownOrderIds = new Set(orders.map((order) => order.id));
    updateOrderAttention(orders);
    dashboardTablesSnapshot = JSON.stringify(tables.map(({ table, occupied, occupiedAt }) => ({ table, occupied, occupiedAt })));
    window.tablyDashboardPoll = setInterval(() => refreshDashboardOrders().catch(() => {}), 8000);
  } catch {
    stopDashboardPolling();
    renderAuth();
  }
}

function renderPlatformLogin(errorMessage = '') {
  stopDashboardPolling();
  topbarMeta.textContent = 'Administración de Tably';
  app.innerHTML = `<div class="auth-wrap"><section class="panel"><h1>Suscripciones de Tably</h1>
    <p class="muted small">Ingresá con las credenciales privadas de administración.</p>${errorMessage ? `<p class="error">${esc(errorMessage)}</p>` : ''}
    <form class="form" id="platform-login-form"><div class="field"><label for="platform-email">Email</label><input id="platform-email" name="email" type="email" required autocomplete="username"></div>
      <div class="field"><label for="platform-password">Contraseña</label><input id="platform-password" name="password" type="password" required autocomplete="current-password"></div>
      <button class="btn primary" type="submit">Iniciar sesión</button></form></section></div>`;
  document.querySelector('#platform-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    busyButton(button, true, 'Iniciar sesión');
    try {
      const form = Object.fromEntries(new FormData(event.currentTarget));
      await api('/api/platform/auth/login', { method: 'POST', body: JSON.stringify(form) });
      await renderPlatformAdmin();
    } catch (error) { renderPlatformLogin(error.message); }
  });
}

async function renderPlatformAdmin() {
  stopDashboardPolling();
  app.innerHTML = '<div class="loading">Cargando suscripciones…</div>';
  try {
    const [admin, cafes] = await Promise.all([api('/api/platform/auth/me'), api('/api/platform/subscriptions')]);
    topbarMeta.innerHTML = `Administración · ${esc(admin.email)} <button class="text-btn" id="platform-logout">Salir</button>`;
    const statusLabels = { trial: 'Prueba', pending: 'Pago pendiente', authorized: 'Activa', cancelled: 'Cancelada', paused: 'Pausada' };
    const rows = cafes.map((cafe) => {
      const due = new Date(cafe.subscriptionDueAt);
      const dueInput = Number.isNaN(due.getTime()) ? '' : [due.getFullYear(), String(due.getMonth() + 1).padStart(2, '0'), String(due.getDate()).padStart(2, '0')].join('-');
      const statusOptions = Object.entries(statusLabels).map(([value, label]) => `<option value="${value}" ${cafe.subscriptionStatus === value ? 'selected' : ''}>${label}</option>`).join('');
      return `<article class="section platform-cafe" data-cafe-id="${cafe.id}"><div class="section-head"><div><h2>${esc(cafe.name)}</h2><span class="muted small">${esc(cafe.email)} · ${cafe.tableCount} mesas · Plan ${cafe.plan === 'ampliado' ? 'Ampliado' : 'Base'}</span></div><div class="platform-statuses"><span class="pill">${statusLabels[cafe.subscriptionStatus] || 'Sin estado'}</span><span class="pill ${cafe.enabled ? 'green' : 'disabled'}">${cafe.enabled ? 'Cuenta habilitada' : 'Cuenta deshabilitada'}</span></div></div>
        <div class="platform-billing-controls"><label class="field"><span>Estado</span><select name="status">${statusOptions}</select></label>
          <label class="field"><span>Vencimiento</span><input name="dueAt" type="date" value="${dueInput}" required></label>
          <div class="platform-actions"><button class="btn secondary small-btn" data-save-subscription="${cafe.id}">Guardar</button><button class="btn green small-btn" data-mark-paid="${cafe.id}">Registrar pago</button><button class="btn ${cafe.enabled ? 'secondary' : 'green'} small-btn" data-toggle-access="${cafe.id}" data-enabled="${cafe.enabled}">${cafe.enabled ? 'Deshabilitar cuenta' : 'Habilitar cuenta'}</button></div></div>
        <p class="muted small">${cafe.subscriptionPaidAt ? `Último pago registrado: ${new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium' }).format(new Date(cafe.subscriptionPaidAt))}` : 'Todavía no hay pagos registrados.'}</p></article>`;
    }).join('');
    app.innerHTML = `<div class="platform-admin"><div class="heading-row"><div><h1>Suscripciones de los cafés</h1><p>Controlá estados, vencimientos y pagos manuales.</p></div><span class="pill">${cafes.length} cafés</span></div>
      <div class="platform-cafe-list">${rows || '<section class="section empty">Todavía no hay cafés registrados.</section>'}</div></div>`;
    document.querySelector('#platform-logout').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' });
      renderPlatformLogin();
    });
    document.querySelectorAll('[data-save-subscription]').forEach((button) => button.addEventListener('click', async () => {
      const card = button.closest('[data-cafe-id]');
      try {
        await api(`/api/platform/subscriptions/${button.dataset.saveSubscription}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: card.querySelector('[name="status"]').value, dueAt: `${card.querySelector('[name="dueAt"]').value}T12:00:00.000Z` }),
        });
        await renderPlatformAdmin();
      } catch (error) { toast(error.message); }
    }));
    document.querySelectorAll('[data-mark-paid]').forEach((button) => button.addEventListener('click', async () => {
      if (!await confirmAction('¿Confirmás que recibiste el pago de este café?')) return;
      try {
        await api(`/api/platform/subscriptions/${button.dataset.markPaid}/paid`, { method: 'POST', body: '{}' });
        await renderPlatformAdmin();
      } catch (error) { toast(error.message); }
    }));
    document.querySelectorAll('[data-toggle-access]').forEach((button) => button.addEventListener('click', async () => {
      const enabled = button.dataset.enabled === 'true';
      if (enabled && !await confirmAction('Al deshabilitar esta cuenta, el local no podrá ingresar ni aceptar pedidos desde sus QR. ¿Querés continuar?')) return;
      try {
        await api(`/api/platform/subscriptions/${button.dataset.toggleAccess}/access`, {
          method: 'PATCH', body: JSON.stringify({ enabled: !enabled }),
        });
        await renderPlatformAdmin();
      } catch (error) { toast(error.message); }
    }));
  } catch (error) {
    if (/administrador|administrar|permiso|sesión|sesion/i.test(error.message)) renderPlatformLogin();
    else app.innerHTML = `<section class="panel"><p>${esc(error.message)}</p></section>`;
  }
}

async function renderMenu(slug) {
  const table = Number(new URLSearchParams(location.search).get('table'));
  const orderId = new URLSearchParams(location.search).get('order_id');
  topbarMeta.textContent = Number.isInteger(table) ? `Mesa ${table}` : '';
  if (orderId) return renderOrderStatus(orderId, slug, table);
  let menu;
  try { menu = await api(`/api/public/${encodeURIComponent(slug)}?table=${table}`); }
  catch (error) {
    if (error.code === 'CAFE_UNAVAILABLE') renderUnavailableNotice(error.message);
    else app.innerHTML = `<section class="panel customer"><h2>No pudimos abrir el menú</h2><p class="muted">${esc(error.message)}</p></section>`;
    return;
  }
  const cart = new Map();
  const paymentStorageKey = `tably-payment:${slug}:${table}`;
  let selectedPayment;
  try { selectedPayment = sessionStorage.getItem(paymentStorageKey); } catch {}
  if (!['card', 'cash'].includes(selectedPayment)) selectedPayment = 'cash';
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
            <label class="payment-option"><input type="radio" name="paymentMethod" value="cash" ${selectedPayment === 'cash' ? 'checked' : ''}><span><strong>Efectivo</strong></span></label>
            <label class="payment-option"><input type="radio" name="paymentMethod" value="card" ${selectedPayment === 'card' ? 'checked' : ''}><span><strong>Tarjeta o transferencias</strong></span></label>
          </fieldset>
          <button class="btn primary pay-confirm" id="place-order">Pagar ${money(total)}</button>
          <div class="payment-explanation" id="payment-explanation" hidden>
            <p id="payment-explanation-text"></p>
            <button class="btn primary pay-confirm" id="confirm-order">Confirmar pedido ${money(total)}</button>
            <button class="checkout-back payment-back" id="edit-payment" type="button">Volver</button>
          </div>
        </section>
      </div>
    </section>`;

    document.querySelector('#checkout-back').addEventListener('click', () => history.back());
    document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => radio.addEventListener('change', () => {
      selectedPayment = radio.value;
      try { sessionStorage.setItem(paymentStorageKey, selectedPayment); } catch {}
    }));
    document.querySelector('#place-order').addEventListener('click', () => {
      document.querySelector('#payment-explanation-text').textContent = `Al confirmar, el local recibirá tu pedido y el personal se acercará a tu mesa para cobrarte ${selectedPayment === 'cash' ? 'en efectivo' : 'con tarjeta, transferencia o Mercado Pago'}.`;
      document.querySelector('#place-order').hidden = true;
      document.querySelector('.payment-options').hidden = true;
      document.querySelector('#payment-explanation').hidden = false;
    });
    document.querySelector('#edit-payment').addEventListener('click', () => {
      document.querySelector('#payment-explanation').hidden = true;
      document.querySelector('.payment-options').hidden = false;
      document.querySelector('#place-order').hidden = false;
    });
    document.querySelector('#confirm-order').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const label = button.textContent;
      busyButton(button, true, label);
      try {
        const order = await api(`/api/public/${encodeURIComponent(slug)}/orders`, {
          method: 'POST',
          body: JSON.stringify({ table, method: selectedPayment, items: items.map((item) => ({ id: item.id, quantity: item.quantity })) }),
        });
        cart.clear();
        const next = new URL(location.href);
        next.searchParams.set('order_id', order.id);
        history.replaceState({}, '', next);
        window.removeEventListener('popstate', handleCheckoutPopState);
        await renderOrderStatus(order.id, slug, table);
      } catch (error) {
        if (error.code === 'CAFE_UNAVAILABLE') {
          window.removeEventListener('popstate', handleCheckoutPopState);
          renderUnavailableNotice(error.message);
        } else {
          toast(error.message);
          busyButton(button, false, label);
        }
      }
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

function renderUnavailableNotice(message) {
  stopDashboardPolling();
  topbarMeta.textContent = '';
  app.innerHTML = `<section class="panel customer service-unavailable" role="status" aria-live="polite"><span class="service-unavailable-mark" aria-hidden="true">!</span><h1>Servicio temporalmente no disponible</h1><p>${esc(message)}</p><p class="muted small">Por favor, intentá nuevamente más tarde.</p></section>`;
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
    const rejectedPayment = order.paymentStatus === 'rejected';
    const orderHeading = rejectedPayment
      ? 'No se confirmó el pago'
      : isPaid
        ? 'Tu pedido está en marcha'
        : 'El personal se acerca a tu mesa';
    const headline = orderHeading;
    const message = isPaid
      ? statusText
      : rejectedPayment
        ? 'El pedido no se envió a cocina. Volvé al menú para realizar otro pedido.'
        : `El local recibió el aviso para cobrar ${money(order.totalArs)} en tu mesa. Podés pagar en efectivo o con tarjeta, transferencia o Mercado Pago.`;
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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshDashboardOrders().catch(() => {});
});

const path = location.pathname;
const route = path.match(/^\/menu\/([^/]+)\/?$/);
const platformAdminMode = path === '/platform-admin' || new URLSearchParams(location.search).has('tably-admin');
if (route) renderMenu(decodeURIComponent(route[1]));
else if (platformAdminMode) renderPlatformAdmin();
else api('/api/auth/me').then(renderDashboard).catch(() => renderAuth());
