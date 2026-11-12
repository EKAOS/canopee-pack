const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
// Après une mise à jour, ce fichier vit hors du zip : les bibliothèques sont chargées via le démarreur.
const need = (global.canopee && global.canopee.require) || require;
const { Client } = need('minecraft-launcher-core');
const { Auth } = need('msmc');
const AdmZip = need('adm-zip');

const UA = 'canopee-launcher/1.0.0';
let win;
const host = global.canopee || { packPath: path.join(__dirname, 'pack.json'), version: 'dev' };
let pack = JSON.parse(fs.readFileSync(host.packPath, 'utf8'));
let minecraftAuth = null; // jeton Minecraft de la session
let running = false;

const root = () => path.join(app.getPath('appData'), '.' + pack.id);
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const send = (channel, data) => win && !win.isDestroyed() && win.webContents.send(channel, data);
const status = (text, value = null) => send('status', { text, value });
const log = (line) => send('log', String(line).trimEnd());

// ---------- Réglages & jeton ----------
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}
function saveToken(token) {
  if (!token) return writeSettings({ token: null });
  const enc = safeStorage.isEncryptionAvailable();
  const value = enc ? safeStorage.encryptString(token).toString('base64') : token;
  writeSettings({ token: { enc, value } });
}
function loadToken() {
  const t = readSettings().token;
  if (!t) return null;
  try { return t.enc ? safeStorage.decryptString(Buffer.from(t.value, 'base64')) : t.value; } catch { return null; }
}

// ---------- Compte Microsoft ----------
async function signIn(interactive) {
  const auth = new Auth('select_account');
  let xbox = null;
  const saved = loadToken();
  if (saved) {
    try { xbox = await auth.refresh(saved); } catch { xbox = null; }
  }
  if (!xbox && interactive) xbox = await auth.launch('electron');
  if (!xbox) return null;
  saveToken(xbox.save());
  minecraftAuth = await xbox.getMinecraft();
  const profile = minecraftAuth.profile || {};
  startPresence();
  return { name: profile.name || 'Joueur', uuid: profile.id || '' };
}

// ---------- Amis : qui est en ligne ----------
let presenceTimer = null;
let presenceStatus = 'launcher';
async function friendsApi(fn, body) {
  const f = pack.friends;
  if (!f || !f.url || !f.key) return null;
  try {
    const res = await fetch(`${f.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: f.key, Authorization: `Bearer ${f.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null; // hors ligne : la liste d'amis est juste indisponible
  }
}
function beat(status = presenceStatus) {
  const profile = minecraftAuth && minecraftAuth.profile;
  if (!profile || !profile.id) return Promise.resolve(null);
  return friendsApi('heartbeat', { p_uuid: profile.id, p_name: profile.name, p_status: status });
}
function startPresence() {
  clearInterval(presenceTimer);
  beat();
  presenceTimer = setInterval(beat, 30000);
}
function setPresence(status) { presenceStatus = status; beat(); }
async function stopPresence() {
  clearInterval(presenceTimer);
  presenceTimer = null;
  await beat('offline');
}

// ---------- Téléchargements ----------
async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} sur ${url}`);
  return res.json();
}
async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

// ---------- Liste de mods distante (optionnelle) ----------
async function refreshPack() {
  if (!pack.remoteUrl) return;
  try {
    pack = { ...pack, ...(await getJson(pack.remoteUrl)) };
  } catch { /* hors ligne : on garde la liste embarquée */ }
}

// ---------- Versions de Minecraft ----------
let manifest = null;
async function getManifest() {
  if (!manifest) manifest = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  return manifest;
}
async function listVersions() {
  try {
    return (await getManifest()).versions.filter((v) => v.type === 'release').map((v) => v.id);
  } catch {
    return [pack.minecraft]; // hors ligne
  }
}
async function javaMajor(mc) {
  try {
    const entry = (await getManifest()).versions.find((v) => v.id === mc);
    const major = (await getJson(entry.url)).javaVersion?.majorVersion || 8;
    return major === 16 ? 17 : major;
  } catch {
    return pack.javaVersion || 21;
  }
}

// ---------- Java ----------
function findJava(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const exe = path.join(dir, entry, 'bin', 'javaw.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}
async function ensureJava(v) {
  if (process.platform !== 'win32') return 'java'; // macOS / Linux : Java du système
  const dir = path.join(root(), 'runtime', 'java' + v);
  let exe = findJava(dir);
  if (exe) return exe;
  status(`Installation de Java ${v}…`);
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const zip = path.join(os.tmpdir(), `canopee-java${v}.zip`);
  await download(`https://api.adoptium.net/v3/binary/latest/${v}/ga/windows/${arch}/jre/hotspot/normal/eclipse`, zip);
  new AdmZip(zip).extractAllTo(dir, true);
  fs.rmSync(zip, { force: true });
  exe = findJava(dir);
  if (!exe) throw new Error("Java n'a pas pu être installé.");
  return exe;
}

// ---------- Fabric ----------
async function ensureFabric() {
  const mc = pack.minecraft;
  const versions = path.join(root(), 'versions');
  try {
    let loader = pack.fabricLoader;
    if (!loader) {
      const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mc}`);
      loader = (list.find((l) => l.loader.stable) || list[0]).loader.version;
    }
    const id = `fabric-loader-${loader}-${mc}`;
    const file = path.join(versions, id, id + '.json');
    if (!fs.existsSync(file)) {
      status('Installation de Fabric…');
      const profile = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(profile));
    }
    writeSettings({ fabricId: id });
    return id;
  } catch (err) {
    // Hors ligne : on réutilise la dernière installation connue
    const last = readSettings().fabricId;
    if (last && fs.existsSync(path.join(versions, last, last + '.json'))) return last;
    throw err;
  }
}

// ---------- Mods (Modrinth, dépendances incluses) ----------
async function resolveMods() {
  const q = (v) => encodeURIComponent(JSON.stringify([v]));
  const wanted = new Map();
  const missing = [];
  const queue = pack.mods.map((id) => ({ id, top: true }));
  const seen = new Set();
  while (queue.length) {
    const { id, top } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const list = await getJson(
        `https://api.modrinth.com/v2/project/${id}/version?loaders=${q('fabric')}&game_versions=${q(pack.minecraft)}`
      );
      const version = list.find((v) => v.version_type === 'release') || list[0];
      if (!version) { if (top) missing.push(id); continue; }
      if (wanted.has(version.project_id)) continue;
      const file = version.files.find((f) => f.primary) || version.files[0];
      wanted.set(version.project_id, { name: file.filename, url: file.url, size: file.size });
      for (const dep of version.dependencies || []) {
        if (dep.dependency_type === 'required' && dep.project_id) queue.push({ id: dep.project_id, top: false });
      }
    } catch {
      if (top) missing.push(id);
    }
    status('Vérification des mods…', seen.size / (seen.size + queue.length));
  }
  return { files: [...wanted.values()], missing };
}

async function syncMods() {
  const dir = path.join(root(), 'mods');
  fs.mkdirSync(dir, { recursive: true });
  const managedFile = path.join(dir, '.canopee.json');
  let managed = [];
  try { managed = JSON.parse(fs.readFileSync(managedFile, 'utf8')); } catch { /* première fois */ }

  let resolved;
  try {
    resolved = await resolveMods();
  } catch {
    return []; // hors ligne : on joue avec les mods déjà présents
  }
  const { files, missing } = resolved;
  if (!files.length && pack.mods.length) return missing; // rien de résolu : on ne touche à rien

  const keep = new Set(files.map((f) => f.name));
  // On ne supprime que les fichiers installés par le launcher, jamais ceux ajoutés à la main
  for (const name of managed) {
    if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
  let done = 0;
  for (const f of files) {
    const dest = path.join(dir, f.name);
    const ok = fs.existsSync(dest) && fs.statSync(dest).size === f.size;
    if (!ok) {
      status(`Téléchargement : ${f.name}`, done / files.length);
      await download(f.url, dest);
    }
    done++;
  }
  fs.writeFileSync(managedFile, JSON.stringify([...keep]));
  return missing;
}

// ---------- Serveur pré-enregistré dans le menu Multijoueur ----------
function ensureServerList() {
  const host = pack.server && pack.server.host;
  if (!host) return;
  const ip = pack.server.port && pack.server.port !== 25565 ? `${host}:${pack.server.port}` : host;
  const file = path.join(root(), 'servers.dat');
  if (fs.existsSync(file)) return; // on ne touche jamais à une liste existante
  const str = (v) => { const b = Buffer.from(v, 'utf8'); const len = Buffer.alloc(2); len.writeUInt16BE(b.length); return Buffer.concat([len, b]); };
  const tag = (type, name) => Buffer.concat([Buffer.from([type]), str(name)]);
  const one = Buffer.alloc(4); one.writeInt32BE(1);
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    tag(10, ''),                                      // racine
    tag(9, 'servers'), Buffer.from([10]), one,        // liste d'un serveur
    tag(8, 'name'), str(pack.server.name || pack.name),
    tag(8, 'ip'), str(ip),
    Buffer.from([0]),                                 // fin du serveur
    Buffer.from([0]),                                 // fin de la racine
  ]));
  log(`Serveur ajouté au menu Multijoueur : ${ip}`);
}

// ---------- Lancement ----------
async function play({ ramGb, mode, version }) {
  if (running) return { ok: false, error: 'Le jeu est déjà lancé.' };
  if (!minecraftAuth) return { ok: false, error: "Connecte-toi d'abord." };
  running = true;
  send('state', 'preparing');
  try {
    writeSettings({ ram: ramGb, mode, version });
    await refreshPack();
    const modded = mode !== 'vanilla';
    const mc = modded ? pack.minecraft : version;
    log(`Lancement : Minecraft ${mc} (${modded ? pack.name + ', moddé' : 'vanilla'})`);

    const javaPath = await ensureJava(await javaMajor(mc));
    const target = { number: mc, type: 'release' };
    if (modded) {
      target.custom = await ensureFabric();
      const missing = await syncMods();
      if (missing.length) log(`Mods introuvables pour ${mc}, ignorés : ${missing.join(', ')}`);
    }
    ensureServerList();

    status('Préparation de Minecraft…');
    await minecraftAuth.refresh();
    const client = new Client();
    client.on('progress', (e) => status(`Téléchargement du jeu (${e.type})…`, e.total ? e.task / e.total : null));
    client.on('debug', log);
    let started = false;
    client.on('data', (line) => {
      log(line);
      if (running && !started) {
        started = true;
        send('state', 'running');
        setPresence('game');
        if (win && !win.isDestroyed()) win.hide(); // une seule fenêtre : le launcher se cache pendant le jeu
      }
    });
    client.on('close', (code) => {
      running = false;
      log(`Jeu fermé (code ${code}).`);
      send('state', 'idle');
      setPresence('launcher');
      if (win && !win.isDestroyed()) { win.show(); win.focus(); } // il revient quand le jeu se ferme
    });

    const options = {
      authorization: minecraftAuth.mclc(),
      root: root(),
      javaPath,
      version: target,
      memory: { max: `${ramGb}G`, min: '2G' },
    };
    if (modded && pack.server && pack.server.host && pack.server.autoConnect) {
      options.quickPlay = { type: 'multiplayer', identifier: `${pack.server.host}:${pack.server.port || 25565}` };
    }
    const child = await client.launch(options);
    if (!child) throw new Error("Minecraft n'a pas démarré. Ouvre la console pour voir pourquoi.");
    status('Minecraft démarre…');
    return { ok: true };
  } catch (err) {
    running = false;
    log('Erreur : ' + (err.stack || err));
    send('state', 'idle');
    return { ok: false, error: err.message || String(err) };
  }
}

// ---------- Fenêtre & IPC ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 660,
    resizable: false,
    frame: false,
    backgroundColor: '#0f1016',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

ipcMain.handle('init', async () => {
  await refreshPack();
  let account = null;
  try { account = await signIn(false); } catch { /* pas de session enregistrée */ }
  const totalGb = Math.floor(os.totalmem() / 1024 ** 3);
  return {
    pack: { name: pack.name, description: pack.description || '', accent: pack.accent || '', minecraft: pack.minecraft, mods: pack.mods },
    launcherVersion: host.version,
    versions: await listVersions(),
    friends: !!(pack.friends && pack.friends.url && pack.friends.key),
    mode: readSettings().mode || 'modded',
    version: readSettings().version || pack.minecraft,
    account,
    ram: readSettings().ram || Math.min(pack.defaultRamGb || 6, Math.max(2, totalGb - 2)),
    maxRam: Math.max(4, totalGb - 2),
  };
});
ipcMain.handle('login', async () => {
  try { return { ok: true, account: await signIn(true) }; }
  catch (err) { return { ok: false, error: 'Connexion annulée ou impossible.' }; }
});
ipcMain.handle('logout', async () => { await stopPresence(); minecraftAuth = null; saveToken(null); return true; });
ipcMain.handle('friends', () => friendsApi('roster'));
ipcMain.handle('play', (_e, o = {}) => play({
  ramGb: Math.max(2, Math.min(32, Number(o.ramGb) || 6)),
  mode: o.mode === 'vanilla' ? 'vanilla' : 'modded',
  version: String(o.version || pack.minecraft),
}));
ipcMain.on('open-folder', () => { fs.mkdirSync(root(), { recursive: true }); shell.openPath(root()); });
ipcMain.on('win-min', () => win.minimize());
ipcMain.on('win-close', () => win.close());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
let leaving = false;
app.on('before-quit', (event) => {            // on se signale hors ligne avant de fermer
  if (leaving || !presenceTimer) return;
  leaving = true;
  event.preventDefault();
  Promise.race([stopPresence(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
});
