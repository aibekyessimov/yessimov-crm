// Простое хранилище: JSON-файлы в папке data/. Без внешних зависимостей.
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'snapshots'), { recursive: true });

function file(name) { return path.join(DATA, name); }

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

function write(name, value) {
  const f = file(name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, f);
}

function list(dir) {
  try { return fs.readdirSync(file(dir)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
}

function settings() { return read('settings.json', {}); }
function saveSettings(patch) { const s = { ...settings(), ...patch }; write('settings.json', s); return s; }

module.exports = { DATA, read, write, list, settings, saveSettings };
