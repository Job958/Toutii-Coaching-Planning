const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { db, save } = require("./store");

// ---------- Admin password: stored as a bcrypt hash, never in plain text ----------

const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
if (!db.config.admin_password_hash) {
  db.config.admin_password_hash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
  save();
}

function verifyAdminPassword(password) {
  if (typeof password !== "string" || password.length === 0) return false;
  return bcrypt.compareSync(password, db.config.admin_password_hash);
}

const MAX_AUDIT_ENTRIES = 300;

function logAction(text) {
  db.auditLog.push({ time: new Date().toISOString(), text });
  if (db.auditLog.length > MAX_AUDIT_ENTRIES) {
    db.auditLog = db.auditLog.slice(-MAX_AUDIT_ENTRIES);
  }
  save();
}

function checkAdmin(req, res, next) {
  const { password } = req.body || {};
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: "Mot de passe administrateur incorrect." });
  }
  next();
}

// ---------- Personal access codes: one per registered person. Entering a code both
// authenticates and identifies who you are — no name is ever taken from client input
// for booking/cancelling. Removing a person kills their code instantly. ----------

if (!db.config.hmac_secret) {
  db.config.hmac_secret = crypto.randomBytes(32).toString("hex");
  save();
}
const HMAC_SECRET = db.config.hmac_secret;

function hashCode(code) {
  return crypto.createHmac("sha256", HMAC_SECRET).update(code).digest("hex");
}

function generatePersonalCode() {
  // 6-digit numeric PIN: easy to read aloud/type, plenty of entropy given rate limiting
  return String(Math.floor(100000 + Math.random() * 900000));
}

function findNameByCodeHash(hash) {
  return Object.keys(db.names).find((name) => db.names[name].codeHash === hash) || null;
}

function codeHashInUse(hash) {
  return Object.values(db.names).some((p) => p.codeHash === hash);
}

// Looks up who a personal code belongs to; attaches req.personName if valid.
function checkAccess(req, res, next) {
  const code = (req.body && req.body.code) || req.query.code;
  if (typeof code !== "string" || code.length === 0) {
    return res.status(401).json({ error: "Code d'accès invalide." });
  }
  const name = findNameByCodeHash(hashCode(code));
  if (!name) return res.status(401).json({ error: "Code d'accès invalide ou expiré." });
  req.personName = name;
  next();
}

// ---------- Input validation helpers ----------

const MAX_PER_SLOT = 4;
const DAY_LABELS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const AUGUST_MONTH_INDEX = 7; // JS months are 0-indexed: January = 0, August = 7

// The studio closes for the whole month of August — checked against the
// actual calendar date of the slot, not just its weekKey, so a week that
// straddles July/August or August/September only closes the days that
// genuinely fall in August.
function isAugustDate(mondayStr, day) {
  const [y, m, d] = mondayStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + day);
  return date.getMonth() === AUGUST_MONTH_INDEX;
}
const MORNING_HOURS = [10, 11, 12, 13];
const EVENING_HOURS = [18, 19, 20, 21];
const VALID_HOURS = [...MORNING_HOURS, ...EVENING_HOURS];
const SATURDAY_IDX = 5; // Monday = 0 ... Saturday = 5
const SATURDAY_HOURS = [10, 11, 12, 13]; // studio closes at 14h on Saturdays, no evening either
const WEEK_KEY_RE = /^\d{4}-W\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LEN = 60;
const DEFAULT_QUOTA = 4;
const MIN_QUOTA = 2;
const MAX_QUOTA = 4;

function cleanQuota(raw, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_QUOTA || n > MAX_QUOTA) return fallback;
  return n;
}

function getQuota(name) {
  const p = db.names[name];
  if (!p) return DEFAULT_QUOTA;
  return Number.isInteger(p.quota) ? p.quota : DEFAULT_QUOTA;
}

// Total reservations a person already holds across the whole week, regardless of slot.
function weeklyUsage(weekKey, name) {
  const week = db.reservations[weekKey];
  if (!week) return 0;
  return Object.values(week).reduce((sum, arr) => sum + (arr.includes(name) ? 1 : 0), 0);
}

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LEN) return null;
  return trimmed;
}

// The studio closes at 13h on Saturdays — no evening sessions that day.
function validSlotParams(weekKey, day, hour) {
  if (typeof weekKey !== "string" || !WEEK_KEY_RE.test(weekKey)) return false;
  if (!Number.isInteger(day) || day < 0 || day > 5) return false;
  const allowedHours = day === SATURDAY_IDX ? SATURDAY_HOURS : VALID_HOURS;
  return allowedHours.includes(hour);
}

function slotKey(day, hour) {
  return `${day}_${hour}`;
}

function getSlot(weekKey, day, hour) {
  const week = db.reservations[weekKey];
  if (!week) return [];
  return week[slotKey(day, hour)] || [];
}

// Reproduces the client's ISO week label calculation, so the server can check
// that the "monday" a client sends really matches the "weekKey" it claims.
function isoWeekLabelFromMonday(monday) {
  const d = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// A week opens for booking on the Saturday at 13:00 that falls 2 days before its Monday.
function weekUnlockDate(monday) {
  const unlock = new Date(monday);
  unlock.setDate(unlock.getDate() - 2);
  unlock.setHours(13, 0, 0, 0);
  return unlock;
}

function checkWeekUnlocked(weekKey, mondayStr) {
  if (typeof mondayStr !== "string" || !DATE_RE.test(mondayStr)) {
    return { ok: false, error: "Date de semaine invalide." };
  }
  const [y, m, d] = mondayStr.split("-").map(Number);
  const monday = new Date(y, m - 1, d);
  if (monday.getDay() !== 1) return { ok: false, error: "Date de semaine invalide." };
  if (isoWeekLabelFromMonday(monday) !== weekKey) {
    return { ok: false, error: "La semaine ne correspond pas à la date fournie." };
  }
  const unlock = weekUnlockDate(monday);
  if (new Date() < unlock) {
    const label = unlock.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    return { ok: false, error: `Les réservations pour cette semaine ouvrent le ${label} à 13h00.` };
  }
  return { ok: true };
}

// ---------- App setup ----------

const app = express();
app.set("trust proxy", 1); // needed for correct client IPs behind Railway/Render/any reverse proxy
// Keep helmet's default protections, but drop "upgrade-insecure-requests":
// that directive silently breaks CSS/JS/image loading whenever the app is
// served over plain HTTP (e.g. testing over the local network at
// http://192.168.x.x:3000, or before HTTPS is set up on a host). Once
// deployed behind real HTTPS (Railway/Render provide it automatically),
// everything is HTTPS anyway, so this directive isn't needed to begin with.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: { "upgrade-insecure-requests": null },
    },
  })
);
app.use(express.json({ limit: "10kb" }));
// Force a fresh copy of static files on every navigation (important while the
// app is actively being tweaked, so a stale phone-cached app.js/style.css
// never lingers) — but WITHOUT "no-store", so the browser's back/forward
// cache (bfcache) still works. "no-store" specifically disables bfcache,
// which is what made hitting the browser's back button feel like an instant
// logout: the whole page (including the in-memory login state) had to be
// torn down and rebuilt from scratch instead of being instantly restored.
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.set("Cache-Control", "no-cache, must-revalidate");
    },
  })
);

// General rate limit for the public API (protects against scraping/abuse/DoS)
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Trop de requêtes. Réessayez dans quelques minutes." },
  })
);

// Strict rate limit on admin login / actions to slow down brute-force attempts.
// Configurable via env var so it can be raised during testing and tightened
// again once the app is live for real coachés — no code change needed either way.
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ADMIN_RATE_LIMIT) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives administrateur. Réessayez dans quelques minutes." },
});
app.use("/api/admin/", adminLimiter);

// Rate limit on personal code checks, to slow down guessing a 6-digit PIN
const accessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ACCESS_RATE_LIMIT) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans quelques minutes." },
});

app.post("/api/access/verify", accessLimiter, checkAccess, (req, res) => {
  res.json({ ok: true, name: req.personName, quota: getQuota(req.personName) });
});

// ---------- Public routes (require a valid personal code) ----------

app.get("/api/week/:weekKey", checkAccess, (req, res) => {
  if (!WEEK_KEY_RE.test(req.params.weekKey)) return res.status(400).json({ error: "Semaine invalide." });
  res.json(db.reservations[req.params.weekKey] || {});
});

app.post("/api/book", checkAccess, (req, res) => {
  const { weekKey, day, hour, monday } = req.body || {};
  const name = req.personName; // identity comes from the verified code, never from client input
  if (!validSlotParams(weekKey, day, hour)) {
    return res.status(400).json({ error: "Requête invalide." });
  }
  if (typeof monday === "string" && DATE_RE.test(monday) && isAugustDate(monday, day)) {
    return res.status(403).json({ error: "Le TSP est fermé pour les vacances d'été (mois d'août)." });
  }
  const lockCheck = checkWeekUnlocked(weekKey, monday);
  if (!lockCheck.ok) return res.status(403).json({ error: lockCheck.error });

  if (!db.reservations[weekKey]) db.reservations[weekKey] = {};
  const key = slotKey(day, hour);
  const slot = db.reservations[weekKey][key] || [];

  if (slot.includes(name)) return res.json({ ok: true });

  const quota = getQuota(name);
  const used = weeklyUsage(weekKey, name);
  if (used >= quota) {
    return res.status(403).json({
      error: `Vous avez atteint votre nombre de séances pour cette semaine (${quota}). Seul l'administrateur peut ajouter une séance supplémentaire.`,
    });
  }
  if (slot.length >= MAX_PER_SLOT) {
    return res.status(409).json({ error: "Ce créneau est complet (4/4). Choisissez un autre horaire." });
  }
  db.reservations[weekKey][key] = [...slot, name];
  save();
  res.json({ ok: true });
});

app.post("/api/cancel", checkAccess, (req, res) => {
  const { weekKey, day, hour } = req.body || {};
  const name = req.personName; // can only ever cancel your own reservation
  if (!validSlotParams(weekKey, day, hour)) {
    return res.status(400).json({ error: "Requête invalide." });
  }
  const key = slotKey(day, hour);
  if (db.reservations[weekKey] && db.reservations[weekKey][key]) {
    db.reservations[weekKey][key] = db.reservations[weekKey][key].filter((n) => n !== name);
    save();
  }
  res.json({ ok: true });
});

// ---------- Admin routes (password required in body, hashed check, rate-limited) ----------

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!verifyAdminPassword(password)) return res.status(401).json({ error: "Mot de passe incorrect." });
  logAction("Connexion administrateur");
  res.json({ ok: true });
});

app.post("/api/admin/week", checkAdmin, (req, res) => {
  const { weekKey } = req.body || {};
  if (!WEEK_KEY_RE.test(weekKey)) return res.status(400).json({ error: "Semaine invalide." });
  res.json(db.reservations[weekKey] || {});
});

app.post("/api/admin/names/list", checkAdmin, (req, res) => {
  const list = Object.keys(db.names)
    .sort((a, b) => a.localeCompare(b, "fr"))
    .map((name) => ({ name, quota: getQuota(name) }));
  res.json(list);
});

app.post("/api/admin/audit-log", checkAdmin, (req, res) => {
  res.json([...db.auditLog].reverse());
});

app.post("/api/admin/names/add", checkAdmin, (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: "Nom invalide." });
  if (db.names[name]) return res.status(409).json({ error: "Ce nom existe déjà." });
  const quota = cleanQuota(req.body && req.body.quota, DEFAULT_QUOTA);

  let code, hash;
  for (let i = 0; i < 5; i++) {
    code = generatePersonalCode();
    hash = hashCode(code);
    if (!codeHashInUse(hash)) break;
  }
  db.names[name] = { codeHash: hash, quota };
  save();
  logAction(`Ajout de « ${name} » (${quota} séances/sem.)`);
  res.json({ ok: true, code, quota });
});

app.post("/api/admin/names/set-quota", checkAdmin, (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name || !db.names[name]) return res.status(404).json({ error: "Personne introuvable." });
  const quota = cleanQuota(req.body && req.body.quota, null);
  if (quota === null) {
    return res.status(400).json({ error: `Le nombre de séances doit être entre ${MIN_QUOTA} et ${MAX_QUOTA}.` });
  }
  db.names[name].quota = quota;
  save();
  logAction(`Quota de « ${name} » modifié → ${quota} séances/sem.`);
  res.json({ ok: true, quota });
});

app.post("/api/admin/names/regenerate-code", checkAdmin, (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name || !db.names[name]) return res.status(404).json({ error: "Personne introuvable." });

  let code, hash;
  for (let i = 0; i < 5; i++) {
    code = generatePersonalCode();
    hash = hashCode(code);
    if (!codeHashInUse(hash)) break;
  }
  db.names[name].codeHash = hash;
  save();
  logAction(`Code régénéré pour « ${name} »`);
  res.json({ ok: true, code });
});

app.post("/api/admin/names/remove", checkAdmin, (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: "Nom invalide." });
  delete db.names[name];
  for (const weekKey of Object.keys(db.reservations)) {
    for (const key of Object.keys(db.reservations[weekKey])) {
      db.reservations[weekKey][key] = db.reservations[weekKey][key].filter((n) => n !== name);
    }
  }
  save();
  logAction(`Suppression de « ${name} »`);
  res.json({ ok: true });
});

app.post("/api/admin/book", checkAdmin, (req, res) => {
  const { weekKey, day, hour } = req.body || {};
  const name = cleanName(req.body && req.body.name);
  if (!validSlotParams(weekKey, day, hour) || !name) {
    return res.status(400).json({ error: "Requête invalide." });
  }
  if (!db.reservations[weekKey]) db.reservations[weekKey] = {};
  const key = slotKey(day, hour);
  const slot = db.reservations[weekKey][key] || [];
  if (!slot.includes(name)) {
    db.reservations[weekKey][key] = [...slot, name];
    save();
    logAction(`Réservation forcée pour « ${name} » — ${weekKey}, ${DAY_LABELS[day]} ${hour}h`);
  }
  res.json({ ok: true });
});

app.post("/api/admin/cancel", checkAdmin, (req, res) => {
  const { weekKey, day, hour } = req.body || {};
  const name = cleanName(req.body && req.body.name);
  if (!validSlotParams(weekKey, day, hour) || !name) {
    return res.status(400).json({ error: "Requête invalide." });
  }
  const key = slotKey(day, hour);
  if (db.reservations[weekKey] && db.reservations[weekKey][key]) {
    db.reservations[weekKey][key] = db.reservations[weekKey][key].filter((n) => n !== name);
    save();
    logAction(`Annulation forcée pour « ${name} » — ${weekKey}, ${DAY_LABELS[day]} ${hour}h`);
  }
  res.json({ ok: true });
});

app.post("/api/admin/password", checkAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
  }
  db.config.admin_password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  logAction("Mot de passe administrateur changé");
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Planning app démarrée sur le port ${PORT}`));
