// node server/paths.js → where start-server.bat / start-server.sh keep the server's data: <Noctyl folder>/NoctylServerData
//
// The Noctyl folder is the desktop app's (skills, agents, models): the one chosen in Settings → Data & Privacy → Storage
// (saved in the app's appdir.json), NOCTYL_APP_DIR, or ~/Noctyl. The data folder ignores itself in git (index.js).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** the desktop app's profile folder, where appdir.json is */
function appProfile() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Noctyl');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Noctyl');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Noctyl');
}
function noctylFolder() {
  if (process.env.NOCTYL_APP_DIR && path.isAbsolute(process.env.NOCTYL_APP_DIR)) return process.env.NOCTYL_APP_DIR;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(appProfile(), 'appdir.json'), 'utf8')).path;
    if (typeof p === 'string' && path.isAbsolute(p)) return p;
  } catch { /* not chosen: the default */ }
  return path.join(os.homedir(), 'Noctyl');
}
const serverDataFolder = () => path.join(noctylFolder(), 'NoctylServerData');

if (require.main === module) console.log(serverDataFolder());
module.exports = { noctylFolder, serverDataFolder };
