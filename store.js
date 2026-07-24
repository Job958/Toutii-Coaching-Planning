// Simple JSON-file-backed store. No native compilation required — this exists
// specifically so `npm install` works on any machine (Windows included)
// without Python/build tools, unlike native modules such as better-sqlite3.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    return { names: {}, reservations: {}, config: {}, auditLog: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      names: parsed.names || {},
      reservations: parsed.reservations || {},
      config: parsed.config || {},
      auditLog: parsed.auditLog || [],
    };
  } catch {
    return { names: {}, reservations: {}, config: {}, auditLog: [] };
  }
}

const db = loadDB();

// Node is single-threaded and this write is synchronous, so no locking needed
// at this scale (a coaching studio's worth of concurrent requests).
function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { db, save };
