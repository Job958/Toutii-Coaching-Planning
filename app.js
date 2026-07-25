const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const MORNING_HOURS = [10, 11, 12, 13];
const EVENING_HOURS = [18, 19, 20, 21];
const MAX_PER_SLOT = 4;
const SATURDAY_IDX = 5; // Monday = 0 ... Saturday = 5 — studio closes at 13h on Saturdays
const SATURDAY_HOURS = [10, 11, 12, 13];
const AUGUST_MONTH_INDEX = 7; // JS months are 0-indexed: January = 0, August = 7

function isAugustDay(monday, dayIdx) {
  const d = new Date(monday);
  d.setDate(d.getDate() + dayIdx);
  return d.getMonth() === AUGUST_MONTH_INDEX;
}

let weekOffset = 0;
let names = []; // only populated for the admin panel (admin-authenticated)
let weekData = {};
let selectedName = ""; // set automatically from the personal access code
let isAdmin = false;
let adminPassword = "";
let weekLocked = false;
let accessCode = "";
let myQuota = null;
let myUsed = 0;
let myTokens = 0;

// ---------- Date helpers ----------

function getMondayOfOffsetWeek(offset) {
  const now = new Date();
  const dow = now.getDay() || 7; // Monday = 1 ... Sunday = 7
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - dow + 1 + offset * 7);
  return monday;
}

function getISOWeekLabel(monday) {
  const d = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function formatDayDate(monday, dayIdx) {
  const d = new Date(monday);
  d.setDate(monday.getDate() + dayIdx);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function formatRange(monday) {
  const end = new Date(monday);
  end.setDate(monday.getDate() + 5);
  const opts = { day: "2-digit", month: "long" };
  return `${monday.toLocaleDateString("fr-FR", opts)} — ${end.toLocaleDateString("fr-FR", opts)}`;
}

function slotKey(dayIdx, hour) {
  return `${dayIdx}_${hour}`;
}

function firstName(fullName) {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0];
}

// A stable, distinct pastel color per person (light-theme friendly: pastel
// background + saturated border/text-adjacent color), so the same person
// always gets the same color across every week — makes it easy to spot at a
// glance who's on which slot without reading every name.
const PERSON_COLORS = [
  { bg: "#E8F2EC", border: "#4C8368" }, // sage green
  { bg: "#E9F0F8", border: "#3E6FA3" }, // blue
  { bg: "#F6EAF2", border: "#A34C87" }, // magenta
  { bg: "#FBF0E1", border: "#B8792A" }, // amber
  { bg: "#EEEAF8", border: "#6E5BA8" }, // violet
  { bg: "#E6F3F1", border: "#2E8C79" }, // teal
  { bg: "#FBECE7", border: "#B85D3E" }, // terracotta
  { bg: "#F1F3E2", border: "#748A2E" }, // olive
  { bg: "#EAF1F4", border: "#3D7D8C" }, // slate blue
  { bg: "#F8EAEE", border: "#B04A5A" }, // rose
];

function personColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PERSON_COLORS[hash % PERSON_COLORS.length];
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A week opens for booking on the Saturday at 13:00 that falls 2 days before its Monday.
function weekUnlockDate(monday) {
  const unlock = new Date(monday);
  unlock.setDate(unlock.getDate() - 2);
  unlock.setHours(13, 0, 0, 0);
  return unlock;
}

function isWeekLocked(monday) {
  return new Date() < weekUnlockDate(monday);
}

// ---------- API ----------

async function apiGet(url) {
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}code=${encodeURIComponent(accessCode)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erreur serveur.");
  return data;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: accessCode, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erreur serveur.");
  return data;
}

// ---------- Data loading ----------

async function loadWeek() {
  const monday = getMondayOfOffsetWeek(weekOffset);
  const weekKey = getISOWeekLabel(monday);
  document.getElementById("weekKeyLabel").textContent = weekKey;
  document.getElementById("weekRangeLabel").textContent = formatRange(monday);
  document.getElementById("todayBtn").hidden = weekOffset === 0;

  weekLocked = isWeekLocked(monday);
  const lockBanner = document.getElementById("lockBanner");
  if (weekLocked) {
    const unlock = weekUnlockDate(monday);
    const label = unlock.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    lockBanner.textContent = `🔒 Les réservations pour cette semaine ouvrent le ${label} à 13h00. Vous pouvez consulter le planning mais pas encore réserver.`;
    lockBanner.hidden = isAdmin; // admin can still act regardless
  } else {
    lockBanner.hidden = true;
  }

  const augustBanner = document.getElementById("augustBanner");
  const hasAugustDay = [0, 1, 2, 3, 4, 5].some((d) => isAugustDay(monday, d));
  if (hasAugustDay) {
    augustBanner.textContent = "☀️ Le TSP est fermé pour les vacances d'été durant le mois d'août.";
    augustBanner.hidden = isAdmin; // admin can still act regardless
  } else {
    augustBanner.hidden = true;
  }

  document.getElementById("loadingBox").hidden = false;
  document.getElementById("gridWrap").hidden = true;
  try {
    weekData = accessCode
      ? await apiGet(`/api/week/${weekKey}`)
      : await apiPost("/api/admin/week", { password: adminPassword, weekKey });
  } catch (e) {
    weekData = {};
    showError(e.message);
  }
  document.getElementById("loadingBox").hidden = true;
  document.getElementById("gridWrap").hidden = false;

  myUsed = selectedName
    ? Object.values(weekData).reduce((sum, arr) => sum + (arr && arr.includes(selectedName) ? 1 : 0), 0)
    : 0;
  updateQuotaDisplay();

  renderGrid();
  renderTotal();
}

function updateQuotaDisplay() {
  const quotaEl = document.getElementById("myQuota");
  const quotaBanner = document.getElementById("quotaBanner");
  if (!selectedName || myQuota === null) {
    quotaEl.textContent = "";
    quotaBanner.hidden = true;
    return;
  }
  const quotaReached = myUsed >= myQuota;
  const tokenText = myTokens > 0 ? ` · 🎟️ ${myTokens} jeton${myTokens > 1 ? "s" : ""} de rattrapage` : "";
  quotaEl.textContent = `(${myUsed}/${myQuota} séances cette semaine${tokenText})`;
  quotaEl.style.color = quotaReached && myTokens === 0 ? "var(--red)" : "";
  if (quotaReached && myTokens === 0 && !isAdmin) {
    quotaBanner.textContent = `Vous avez atteint votre nombre de séances pour cette semaine (${myQuota}) et n'avez aucun jeton de rattrapage disponible. Seul l'administrateur peut ajouter une séance supplémentaire.`;
    quotaBanner.hidden = false;
  } else {
    quotaBanner.hidden = true;
  }
}

function currentWeekKey() {
  return getISOWeekLabel(getMondayOfOffsetWeek(weekOffset));
}

function currentMondayStr() {
  return toDateStr(getMondayOfOffsetWeek(weekOffset));
}

// ---------- Rendering ----------

function showError(msg) {
  const box = document.getElementById("errorBox");
  box.textContent = msg;
  box.hidden = false;
  setTimeout(() => (box.hidden = true), 5000);
}

function renderTotal() {
  const total = Object.values(weekData).reduce((s, arr) => s + (arr ? arr.length : 0), 0);
  document.getElementById("totalBookings").textContent = `${total} réservation${total !== 1 ? "s" : ""}`;
}

function getSlot(dayIdx, hour) {
  return weekData[slotKey(dayIdx, hour)] || [];
}

function renderGrid() {
  const monday = getMondayOfOffsetWeek(weekOffset);
  const wrap = document.getElementById("gridWrap");
  wrap.innerHTML = "";

  const inner = document.createElement("div");
  inner.className = "grid-inner";

  // Day header row
  const headerRow = document.createElement("div");
  headerRow.className = "grid-row";
  const corner = document.createElement("div");
  corner.className = "corner-cell";
  headerRow.appendChild(corner);
  DAYS.forEach((day, i) => {
    const cell = document.createElement("div");
    cell.className = "day-header";
    cell.innerHTML = `<div class="day-name">${day}</div><div class="day-date">${formatDayDate(monday, i)}</div>`;
    headerRow.appendChild(cell);
  });
  inner.appendChild(headerRow);

  inner.appendChild(buildBlock("Matin", MORNING_HOURS));
  inner.appendChild(buildBlock("Soir", EVENING_HOURS));

  wrap.appendChild(inner);
}

function buildBlock(label, hours) {
  const frag = document.createDocumentFragment();
  const labelRow = document.createElement("div");
  labelRow.className = "block-label";
  labelRow.textContent = label;
  frag.appendChild(labelRow);

  hours.forEach((hour) => {
    const row = document.createElement("div");
    row.className = "grid-row";

    const hourCell = document.createElement("div");
    hourCell.className = "hour-cell";
    hourCell.textContent = `${hour}h–${hour + 1}h`;
    row.appendChild(hourCell);

    DAYS.forEach((_, dayIdx) => {
      row.appendChild(buildSlotCell(dayIdx, hour));
    });

    frag.appendChild(row);
  });

  const container = document.createElement("div");
  container.appendChild(frag);
  return container;
}

function buildSlotCell(dayIdx, hour) {
  const isClosed = dayIdx === SATURDAY_IDX && !SATURDAY_HOURS.includes(hour);
  if (isClosed) {
    const cell = document.createElement("div");
    cell.className = "slot-cell slot-cell-closed";
    const status = document.createElement("div");
    status.className = "status-text";
    status.textContent = "Fermé";
    cell.appendChild(status);
    return cell;
  }

  const slot = getSlot(dayIdx, hour);
  const full = slot.length >= MAX_PER_SLOT;
  const iAmIn = selectedName && slot.includes(selectedName);

  const cell = document.createElement("div");
  cell.className = "slot-cell";

  slot.forEach((n) => {
    const chip = document.createElement("div");
    chip.className = "chip" + (n === selectedName ? " mine" : "");
    const color = personColor(n);
    chip.style.background = color.bg;
    chip.style.borderLeftColor = color.border;
    chip.title = n;
    const span = document.createElement("span");
    span.textContent = firstName(n);
    chip.appendChild(span);
    if (n === selectedName || isAdmin) {
      const btn = document.createElement("button");
      btn.textContent = "✕";
      btn.setAttribute("aria-label", `Annuler ${n}`);
      btn.onclick = () => cancelBooking(dayIdx, hour, n);
      chip.appendChild(btn);
    }
    cell.appendChild(chip);
  });

  const quotaReached = myQuota !== null && myUsed >= myQuota && myTokens <= 0;
  const august = isAugustDay(getMondayOfOffsetWeek(weekOffset), dayIdx);

  if (!isAdmin && !full && !iAmIn && !weekLocked && !quotaReached && !august) {
    const btn = document.createElement("button");
    btn.className = "reserve-btn";
    btn.textContent = "+ Réserver";
    btn.onclick = () => book(dayIdx, hour);
    cell.appendChild(btn);
  }

  if (!isAdmin && full && !iAmIn) {
    const status = document.createElement("div");
    status.className = "status-text";
    status.textContent = "Complet";
    cell.appendChild(status);
  }

  if (!isAdmin && august && slot.length === 0) {
    const status = document.createElement("div");
    status.className = "status-text";
    status.textContent = "☀️ Fermé";
    cell.appendChild(status);
  }

  if (!isAdmin && !august && slot.length === 0 && !weekLocked) {
    const status = document.createElement("div");
    status.className = "status-text";
    status.textContent = "Libre";
    cell.appendChild(status);
  }

  if (!isAdmin && !august && weekLocked && slot.length === 0) {
    const status = document.createElement("div");
    status.className = "status-text";
    status.textContent = "🔒";
    cell.appendChild(status);
  }

  if (isAdmin) {
    const row = document.createElement("div");
    row.className = "admin-add-row";
    const select = document.createElement("select");
    const optDefault = document.createElement("option");
    optDefault.value = "";
    optDefault.textContent = "Ajouter";
    select.appendChild(optDefault);
    names
      .filter((p) => !slot.includes(p.name))
      .forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.name;
        opt.textContent = p.name;
        select.appendChild(opt);
      });
    const btn = document.createElement("button");
    btn.textContent = "OK";
    btn.onclick = () => {
      if (select.value) adminForceAdd(dayIdx, hour, select.value);
    };
    row.appendChild(select);
    row.appendChild(btn);
    cell.appendChild(row);
  }

  return cell;
}

// ---------- Actions ----------

let toastTimer = null;
function showToast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2500);
}

// Auto-lock the admin session after 5 minutes of inactivity — protects against
// someone finding an unattended, still-logged-in device/tab.
const ADMIN_IDLE_LIMIT_MS = 5 * 60 * 1000;
let adminIdleTimer = null;

function resetAdminIdleTimer() {
  clearTimeout(adminIdleTimer);
  if (!isAdmin) return;
  adminIdleTimer = setTimeout(adminAutoLogout, ADMIN_IDLE_LIMIT_MS);
}

function adminAutoLogout() {
  if (!isAdmin) return;
  isAdmin = false;
  adminPassword = "";
  document.getElementById("adminModal").hidden = true;
  document.getElementById("adminLoginPane").hidden = false;
  document.getElementById("adminPanelPane").hidden = true;
  document.getElementById("adminLockIcon").textContent = "🔒";
  document.getElementById("adminToggleBtn").classList.remove("active");
  if (document.getElementById("appRoot").hidden === false && !selectedName) {
    // Admin was browsing with no personal code of their own — nothing left to show.
    location.reload();
    return;
  }
  renderGrid();
  showToast("Session administrateur verrouillée (inactivité)");
}

["click", "keydown", "touchstart"].forEach((evt) =>
  document.addEventListener(evt, () => resetAdminIdleTimer(), { passive: true })
);

async function book(dayIdx, hour) {
  try {
    const result = await apiPost("/api/book", {
      weekKey: currentWeekKey(),
      monday: currentMondayStr(),
      day: dayIdx,
      hour,
    });
    if (typeof result.tokensRemaining === "number") myTokens = result.tokensRemaining;
    await loadWeek();
    const msg = result.usedToken
      ? `✓ Réservation confirmée avec un jeton de rattrapage — ${DAYS[dayIdx]} ${hour}h-${hour + 1}h`
      : `✓ Réservation confirmée — ${DAYS[dayIdx]} ${hour}h-${hour + 1}h`;
    showToast(msg);
  } catch (e) {
    showError(e.message);
  }
}

async function cancelBooking(dayIdx, hour, name) {
  try {
    const url = isAdmin && name !== selectedName ? "/api/admin/cancel" : "/api/cancel";
    const body = { weekKey: currentWeekKey(), day: dayIdx, hour, name };
    if (url === "/api/admin/cancel") body.password = adminPassword;
    await apiPost(url, body);
    await loadWeek();
  } catch (e) {
    showError(e.message);
  }
}

async function adminForceAdd(dayIdx, hour, name) {
  try {
    await apiPost("/api/admin/book", { password: adminPassword, weekKey: currentWeekKey(), day: dayIdx, hour, name });
    await loadWeek();
  } catch (e) {
    showError(e.message);
  }
}

async function loadAdminNames() {
  names = await apiPost("/api/admin/names/list", { password: adminPassword });
  renderAdminNamesList();
}

async function addRegisteredName() {
  const input = document.getElementById("newNameInput");
  const quotaInput = document.getElementById("newQuotaInput");
  const name = input.value.trim();
  if (!name) return;
  const quota = parseInt(quotaInput.value, 10) || 4;
  try {
    const result = await apiPost("/api/admin/names/add", { password: adminPassword, name, quota });
    input.value = "";
    quotaInput.value = "4";
    showCodeReveal(name, result.code, result.quota);
    await loadAdminNames();
    await loadWeek();
  } catch (e) {
    showError(e.message);
  }
}

async function setQuota(name, quota) {
  try {
    await apiPost("/api/admin/names/set-quota", { password: adminPassword, name, quota });
    await loadAdminNames();
    await loadWeek();
  } catch (e) {
    showError(e.message);
  }
}

async function regenerateCode(name) {
  try {
    const result = await apiPost("/api/admin/names/regenerate-code", { password: adminPassword, name });
    showCodeReveal(name, result.code);
  } catch (e) {
    showError(e.message);
  }
}

async function removeRegisteredName(name) {
  try {
    await apiPost("/api/admin/names/remove", { password: adminPassword, name });
    await loadAdminNames();
    await loadWeek();
  } catch (e) {
    showError(e.message);
  }
}

async function changeAdminPassword() {
  const input = document.getElementById("newPasswordInput");
  const val = input.value.trim();
  if (!val) return;
  try {
    await apiPost("/api/admin/password", { password: adminPassword, newPassword: val });
    adminPassword = val;
    input.value = "";
    showError("Mot de passe changé avec succès.");
  } catch (e) {
    showError(e.message);
  }
}

function showCodeReveal(name, code, quota) {
  const box = document.getElementById("newCodeReveal");
  box.innerHTML = "";
  box.hidden = false;

  const closeRow = document.createElement("div");
  closeRow.className = "code-reveal-close-row";
  const closeBtn = document.createElement("button");
  closeBtn.className = "link-btn";
  closeBtn.textContent = "✕ Fermer";
  closeBtn.onclick = () => {
    box.hidden = true;
  };
  closeRow.appendChild(closeBtn);

  const nameLine = document.createElement("div");
  nameLine.className = "code-reveal-name";
  nameLine.textContent = name;

  const codeBoxes = document.createElement("div");
  codeBoxes.className = "code-reveal-boxes";
  code.split("").forEach((digit) => {
    const d = document.createElement("div");
    d.className = "code-reveal-digit";
    d.textContent = digit;
    codeBoxes.appendChild(d);
  });

  const copyBtn = document.createElement("button");
  copyBtn.className = "code-reveal-copy-btn";
  copyBtn.textContent = "📋 Copier le code";
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = "✓ Copié !";
      setTimeout(() => {
        copyBtn.textContent = "📋 Copier le code";
      }, 1800);
    } catch {
      copyBtn.textContent = "Copie impossible — notez-le manuellement";
    }
  };

  box.appendChild(closeRow);
  box.appendChild(nameLine);
  box.appendChild(codeBoxes);
  box.appendChild(copyBtn);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderAdminNamesList() {
  const list = document.getElementById("namesList");
  document.getElementById("namesCount").textContent = names.length;
  list.innerHTML = "";
  if (names.length === 0) {
    list.innerHTML = '<p class="muted small" style="padding:12px;">Aucune personne pour l\'instant.</p>';
    return;
  }
  names.forEach((p) => {
    const row = document.createElement("div");
    row.className = "name-row";

    const span = document.createElement("span");
    span.textContent = p.name;

    const quotaWrap = document.createElement("div");
    quotaWrap.className = "quota-edit";
    const quotaInput = document.createElement("input");
    quotaInput.type = "number";
    quotaInput.min = "2";
    quotaInput.max = "4";
    quotaInput.value = p.quota;
    quotaInput.className = "quota-input";
    quotaInput.title = "Séances par semaine";
    const quotaLabel = document.createElement("span");
    quotaLabel.className = "mono small muted";
    quotaLabel.textContent = "séances/sem.";
    const quotaSaveBtn = document.createElement("button");
    quotaSaveBtn.className = "regen-btn";
    quotaSaveBtn.textContent = "Enregistrer";
    quotaSaveBtn.onclick = () => setQuota(p.name, parseInt(quotaInput.value, 10) || p.quota);
    quotaWrap.appendChild(quotaInput);
    quotaWrap.appendChild(quotaLabel);
    quotaWrap.appendChild(quotaSaveBtn);

    const actions = document.createElement("div");
    actions.className = "name-row-actions";
    const regenBtn = document.createElement("button");
    regenBtn.className = "regen-btn";
    regenBtn.textContent = "Régénérer le code";
    regenBtn.onclick = () => regenerateCode(p.name);
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Retirer";
    removeBtn.onclick = () => removeRegisteredName(p.name);
    actions.appendChild(regenBtn);
    actions.appendChild(removeBtn);

    const tokenWrap = document.createElement("div");
    tokenWrap.className = "quota-edit";
    const tokenLabel = document.createElement("span");
    tokenLabel.className = "mono small";
    tokenLabel.style.color = p.tokens > 0 ? "var(--accent)" : "var(--muted)";
    tokenLabel.textContent = `🎟️ ${p.tokens || 0} jeton${(p.tokens || 0) > 1 ? "s" : ""} de rattrapage`;
    const tokenAddBtn = document.createElement("button");
    tokenAddBtn.className = "regen-btn";
    tokenAddBtn.textContent = "+1 jeton";
    tokenAddBtn.onclick = () => adjustTokens(p.name, 1);
    tokenWrap.appendChild(tokenLabel);
    tokenWrap.appendChild(tokenAddBtn);
    if (p.tokens > 0) {
      const tokenRemoveBtn = document.createElement("button");
      tokenRemoveBtn.className = "regen-btn";
      tokenRemoveBtn.textContent = "-1 jeton";
      tokenRemoveBtn.onclick = () => adjustTokens(p.name, -1);
      tokenWrap.appendChild(tokenRemoveBtn);
    }

    row.appendChild(span);
    row.appendChild(quotaWrap);
    row.appendChild(tokenWrap);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function adjustTokens(name, delta) {
  try {
    await apiPost("/api/admin/names/set-tokens", { password: adminPassword, name, delta });
    await loadAdminNames();
  } catch (e) {
    showError(e.message);
  }
}

// ---------- Admin login/modal ----------

async function tryAdminLogin() {
  const input = document.getElementById("adminPasswordInput");
  const pwd = input.value;
  try {
    await apiPost("/api/admin/login", { password: pwd });
    isAdmin = true;
    adminPassword = pwd;
    resetAdminIdleTimer();
    document.getElementById("adminLoginPane").hidden = true;
    document.getElementById("adminPanelPane").hidden = false;
    document.getElementById("adminLockIcon").textContent = "🔓";
    document.getElementById("adminToggleBtn").classList.add("active");
    document.getElementById("lockBanner").hidden = true;
    document.getElementById("newCodeReveal").hidden = true;
    await loadAdminNames();
    input.value = "";

    // Admin can view and manage the full calendar even without their own
    // personal code — reveal the main app if we're still on the gate screen.
    if (document.getElementById("appRoot").hidden) {
      document.getElementById("connectedName").textContent = "Toutii";
      document.getElementById("accessGate").hidden = true;
      document.getElementById("appRoot").hidden = false;
      await loadWeek();
    } else {
      renderGrid();
    }

    // Land on the calendar rather than forcing the management panel open —
    // the admin can reopen it via the "Administration" button whenever they want.
    closeAdminModal();
  } catch (e) {
    showError(e.message);
    input.value = "";
  }
}

function openAdminModal() {
  document.getElementById("adminModal").hidden = false;
}
function closeAdminModal() {
  document.getElementById("adminModal").hidden = true;
}

// ---------- Init & events ----------

document.getElementById("prevWeekBtn").onclick = () => {
  weekOffset -= 1;
  loadWeek();
};
document.getElementById("nextWeekBtn").onclick = () => {
  weekOffset += 1;
  loadWeek();
};
document.getElementById("todayBtn").onclick = () => {
  weekOffset = 0;
  loadWeek();
};
document.getElementById("adminToggleBtn").onclick = openAdminModal;
document.getElementById("adminToggleBtnGate").onclick = openAdminModal;
document.getElementById("closeAdminBtn").onclick = closeAdminModal;
document.getElementById("adminModal").onclick = (e) => {
  if (e.target.id === "adminModal") closeAdminModal();
};
document.getElementById("adminLoginBtn").onclick = tryAdminLogin;
document.getElementById("adminPasswordInput").onkeydown = (e) => {
  if (e.key === "Enter") tryAdminLogin();
};
document.getElementById("addNameBtn").onclick = addRegisteredName;
document.getElementById("newNameInput").onkeydown = (e) => {
  if (e.key === "Enter") addRegisteredName();
};
document.getElementById("changePasswordBtn").onclick = changeAdminPassword;

async function exportData() {
  const btn = document.getElementById("exportDataBtn");
  const original = btn.textContent;
  btn.textContent = "Préparation…";
  btn.disabled = true;
  try {
    const res = await fetch("/api/admin/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Échec de l'export.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `toutii-coaching-sauvegarde-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("💾 Sauvegarde téléchargée");
  } catch (e) {
    showError(e.message);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}
document.getElementById("exportDataBtn").onclick = exportData;

function switchAdminTab(tab) {
  const isPeople = tab === "people";
  document.getElementById("tabPeople").hidden = !isPeople;
  document.getElementById("tabSettings").hidden = isPeople;
  document.getElementById("tabPeopleBtn").classList.toggle("active", isPeople);
  document.getElementById("tabSettingsBtn").classList.toggle("active", !isPeople);
  if (!isPeople) {
    loadAuditLog();
    refreshPushStatus();
  }
}
document.getElementById("tabPeopleBtn").onclick = () => switchAdminTab("people");
document.getElementById("tabSettingsBtn").onclick = () => switchAdminTab("settings");

async function loadAuditLog() {
  const list = document.getElementById("auditLogList");
  list.innerHTML = '<p class="muted small" style="padding:12px;">Chargement…</p>';
  try {
    const entries = await apiPost("/api/admin/audit-log", { password: adminPassword });
    if (entries.length === 0) {
      list.innerHTML = '<p class="muted small" style="padding:12px;">Aucune action enregistrée pour l\'instant.</p>';
      return;
    }
    list.innerHTML = "";
    entries.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "audit-log-row";
      const time = document.createElement("span");
      time.className = "audit-log-time";
      time.textContent = new Date(entry.time).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const text = document.createElement("span");
      text.textContent = entry.text;
      row.appendChild(time);
      row.appendChild(text);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = `<p class="muted small" style="padding:12px;">${e.message}</p>`;
  }
}
document.getElementById("logoutBtn").onclick = () => {
  accessCode = "";
  selectedName = "";
  localStorage.removeItem("toutii_code");
  location.reload();
};

// ---------- Access gate ----------

async function tryAccessCode(silent) {
  const boxes = Array.from(document.querySelectorAll(".pin-box"));
  const errorEl = document.getElementById("accessError");
  const code = silent || boxes.map((b) => b.value).join("");
  if (code.length !== 6) return;
  try {
    const res = await fetch("/api/access/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) {
      localStorage.removeItem("toutii_code");
      if (silent) return; // a saved code went stale (regenerated/removed) — just show the gate normally
      errorEl.textContent = data.error || "Code incorrect.";
      errorEl.hidden = false;
      boxes.forEach((b) => {
        b.value = "";
        b.classList.remove("filled");
      });
      boxes[0].focus();
      return;
    }
    accessCode = code;
    selectedName = data.name;
    myQuota = data.quota;
    myTokens = data.tokens || 0;
    localStorage.setItem("toutii_code", code);

    // A personal-code login is always a clean, non-admin session — even if this
    // browser tab previously had an admin session open, it must not carry over.
    isAdmin = false;
    adminPassword = "";
    document.getElementById("adminModal").hidden = true;
    document.getElementById("adminLoginPane").hidden = false;
    document.getElementById("adminPanelPane").hidden = true;
    document.getElementById("adminLockIcon").textContent = "🔒";
    document.getElementById("adminToggleBtn").classList.remove("active");

    document.getElementById("connectedName").textContent = data.name;
    document.getElementById("accessGate").hidden = true;
    document.getElementById("appRoot").hidden = false;
    await loadWeek();
  } catch (e) {
    if (silent) return;
    errorEl.textContent = "Erreur de connexion. Réessayez.";
    errorEl.hidden = false;
  }
}

// Silently restore a previous session on load — this is what stops a mobile
// browser's background tab reclaiming (or hitting "back") from feeling like
// an unexpected logout: same code, remembered locally, no re-typing needed.
(function restoreSession() {
  const saved = localStorage.getItem("toutii_code");
  if (saved && saved.length === 6) tryAccessCode(saved);
})();

// ---------- PIN boxes: type-to-advance, backspace-to-retreat, paste support ----------
const pinBoxes = Array.from(document.querySelectorAll(".pin-box"));

pinBoxes.forEach((box, i) => {
  box.addEventListener("input", () => {
    box.value = box.value.replace(/[^0-9]/g, "").slice(0, 1);
    box.classList.toggle("filled", box.value !== "");
    if (box.value && i < pinBoxes.length - 1) {
      pinBoxes[i + 1].focus();
    }
    if (pinBoxes.every((b) => b.value !== "")) {
      tryAccessCode();
    }
  });

  box.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !box.value && i > 0) {
      pinBoxes[i - 1].focus();
      pinBoxes[i - 1].value = "";
      pinBoxes[i - 1].classList.remove("filled");
      e.preventDefault();
    }
    if (e.key === "Enter") tryAccessCode();
  });

  box.addEventListener("paste", (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData("text").replace(/[^0-9]/g, "");
    if (pasted.length === 0) return;
    e.preventDefault();
    pasted
      .slice(0, 6)
      .split("")
      .forEach((digit, idx) => {
        if (pinBoxes[idx]) {
          pinBoxes[idx].value = digit;
          pinBoxes[idx].classList.add("filled");
        }
      });
    const next = pinBoxes[Math.min(pasted.length, 5)];
    if (next) next.focus();
    if (pinBoxes.every((b) => b.value !== "")) tryAccessCode();
  });
});

// Note: no submit button — the 6th digit triggers verification automatically.
// Note: no auto-focus on the first box — some browsers leave a stray
// "ghost" blinking caret near the top of the page when an input is
// programmatically focused before webfonts finish loading. Not worth the
// visual glitch for the minor convenience of not clicking the field first.

// ---------- PWA: register service worker for installability & offline resilience ----------
let swRegistration = null;
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((reg) => {
        swRegistration = reg;
        if (isAdmin) refreshPushStatus();
      })
      .catch(() => {});
  });
}

// ---------- Push notifications (admin only) ----------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function refreshPushStatus() {
  const statusEl = document.getElementById("pushStatus");
  const btn = document.getElementById("pushToggleBtn");
  if (!statusEl || !btn) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    statusEl.textContent = "Les notifications ne sont pas prises en charge sur ce navigateur.";
    btn.hidden = true;
    return;
  }
  if (!swRegistration) return;
  const existing = await swRegistration.pushManager.getSubscription();
  if (existing) {
    btn.textContent = "🔕 Désactiver les notifications";
    statusEl.textContent = "Notifications activées sur cet appareil.";
  } else {
    btn.textContent = "🔔 Activer les notifications";
    statusEl.textContent = "";
  }
}

async function togglePush() {
  const statusEl = document.getElementById("pushStatus");
  if (!swRegistration) {
    statusEl.textContent = "Service worker pas encore prêt — réessayez dans un instant.";
    return;
  }
  const existing = await swRegistration.pushManager.getSubscription();
  if (existing) {
    try {
      await apiPost("/api/admin/push/unsubscribe", { password: adminPassword, endpoint: existing.endpoint });
      await existing.unsubscribe();
    } catch (e) {
      showError(e.message);
    }
    await refreshPushStatus();
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    statusEl.textContent = "Autorisation refusée — activez les notifications dans les réglages du navigateur pour ce site.";
    return;
  }
  try {
    const { publicKey } = await (await fetch("/api/push/vapid-public-key")).json();
    const subscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await apiPost("/api/admin/push/subscribe", { password: adminPassword, subscription });
    await refreshPushStatus();
    showToast("🔔 Notifications activées");
  } catch (e) {
    statusEl.textContent = "Impossible d'activer les notifications sur cet appareil.";
  }
}

const pushToggleBtn = document.getElementById("pushToggleBtn");
if (pushToggleBtn) pushToggleBtn.onclick = togglePush;
