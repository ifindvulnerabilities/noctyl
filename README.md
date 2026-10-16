<div align="center">

<p>

  <a href="https://github.com/ifindvulnerabilities/noctyl">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/Noctyl-LogoBanner-Dark.svg">
      <img alt="Noctyl" src="assets/Noctyl-LogoBanner-Light.svg" width="240">
    </picture>
  </a>
</p>

</div>

# Noctyl
The ultimate privacy-focused agent harness that allows you to bring all your local and external providers to one unified platform. Nothing leaves your system unless you use external providers.

![Application Preview](/assets/noctyl-preview.gif)

# Getting Started with Noctyl
To get started with Noctyl, install [Node.JS](https://nodejs.org/en/download) if you haven't already. Then follow the instructions below:

## Installation
```
mkdir Noctyl
git clone https://github.com/ifindvulnerabilities/noctyl Noctyl
cd Noctyl
npm install # install dependencies
```

## Launching Noctyl as a Desktop Application
Noctyl can be compiled into a desktop application, or launched without compilation using npm.

### Compilation
```
npm run dist:<OS> # (win,linux,mac)
```

### Without Compilation
```
npm start
```

## Served as a Web App
In addition to the desktop GUI, Noctyl can be served as a web app making it accessible across devices.

You can start the web server on your Desktop or even a VPS.

> [!NOTE]
> If you're worried about the security of your deployment, look into tailscale. (not sponsored)

### Quick Start
```
./start-server.bat # Windows

./start-server.sh # Linux
```

### Manual Start
```
node server/index.js --data <folder> --port <port> --host <address> --mode <mode> --ollama <address>
```

# Additional documentation for server

#### Starting the web server manually

The quick-start scripts (`start-server.bat` / `start-server.sh`) only ask a few questions and then run one command. You can run that command yourself and get the same setup.

**Requirements:** Node.js **22.13 or newer**. The server has no npm dependencies, so `npm install` isn't needed to run it.

From the project folder:

```bash
node server/index.js --data <folder> --port <port> --host <address> --mode <mode> --ollama <address>
```

**Linux / macOS**

```bash
node server/index.js --data ~/Noctyl/NoctylServerData --port 8787 --host 0.0.0.0 --mode admin --ollama local
```

**Windows (Command Prompt)**

```bat
node server\index.js --data "%USERPROFILE%\Noctyl\NoctylServerData" --port 8787 --host 0.0.0.0 --mode admin --ollama local
```

#### Options

Each option answers one of the quick-start's questions.

| Option | Quick-start question | Values |
|---|---|---|
| `--data` | *(chosen by the script)* | The data folder. Use `~/Noctyl/NoctylServerData` to share accounts and chats with the quick-start. |
| `--mode` | Who can sign in? | `single` (just you), `open` (anyone can sign up), `admin` (only admins add accounts) |
| `--port` | Port | e.g. `8787` |
| `--host` | Which address should it answer on? | `0.0.0.0` (every address), `127.0.0.1` (this computer only), or a single IP, e.g. a Tailscale `100.x.y.z` (only your tailnet) |
| `--ollama` | Where does Ollama run? | `local` (this computer), or another device: `100.101.102.103`, `my-desktop:11434`, `http://my-desktop:11434` |

> [!NOTE]
> **Defaults differ from the quick-start.**
> - Without `--data`, the server uses its own folder: `%APPDATA%\Noctyl Server` (Windows), `~/Library/Application Support/Noctyl Server` (macOS), `~/.local/share/noctyl-server` (Linux, or `$XDG_DATA_HOME/noctyl-server`).
> - Without `--host`, it answers on this computer only (`127.0.0.1`); the quick-start defaults to every address (`0.0.0.0`).

#### What's remembered

| Setting | Saved? |
|---|---|
| `--mode`, `--ollama` | Yes, in `config.json` in the data folder. Later starts keep them, so you can leave them out. |
| `--port`, `--host` | No, they apply to that run only. Pass them each time, or set `"port"` / `"host"` in `config.json`. |

#### Environment variables

These can be used instead of the options:

| Variable | Same as |
|---|---|
| `NOCTYL_SERVER_DATA` | `--data` |
| `PORT` | `--port` |
| `NOCTYL_HOST` | `--host` |
| `NOCTYL_OLLAMA` | `--ollama` |

```bash
NOCTYL_SERVER_DATA=/srv/noctyl PORT=8787 NOCTYL_HOST=0.0.0.0 node server/index.js
```

#### First start

1. The terminal prints a **setup code**.
2. Open `http://<address>:<port>/login` and create the first account with that code.
3. That account is the **owner and admin**.

Everything else can then be changed in **Settings → Admin → Access** (sign-in time limits, commands, Ollama, shared addresses) or in `config.json` in the data folder.

#### `config.json` reference

| Key | Default | Description |
|---|---|---|
| `port` | `8787` | Port to listen on |
| `host` | `"127.0.0.1"` | Address to answer on (`"0.0.0.0"` for every address) |
| `registration` | `"single"` | `single`, `open` or `admin` |
| `maxUsers` | `0` | Most accounts (`0` = no limit) |
| `sessionHours` | `6` | How long a sign-in lasts (6 at most) |
| `idleMinutes` | `120` | Sign out after this long without use |
| `trustProxy` | `false` | Set `true` behind a reverse proxy (reads the client address and HTTPS from `X-Forwarded-*`) |
| `secureCookies` | `"auto"` | `"auto"` (secure when the request is HTTPS), `true` or `false` |
| `privateNetwork` | `"admins"` | Who may reach this computer's network through the server: `everyone`, `admins` or `nobody` |
| `sharedHosts` | `["localhost:11434", "127.0.0.1:11434"]` | `host:port` addresses every account may reach |
| `ollamaUrl` | `""` | The Ollama every account uses (`""` = this computer) |
| `commands` | `"off"` | Agent commands from the web version: `off` or `admins` |

> [!TIP]
> Edit `config.json` while the server is stopped, then start it again.

#### Managing accounts from the terminal

Run these while the server is stopped, and add `--data <folder>` so they act on the right data folder:

| Command | What it does |
|---|---|
| `node server/index.js mode` | Show the sign-up mode |
| `node server/index.js mode <single\|open\|admin>` | Change the sign-up mode |
| `node server/index.js accounts` | List accounts |
| `node server/index.js admin <name> [off]` | Make an account an admin (or not) |
| `node server/index.js owner <name>` | The account that can sign in while the mode is `single` |
| `node server/index.js remove <name>` | Delete an account and its data |

```bash
node server/index.js accounts --data ~/Noctyl/NoctylServerData
```

> [!IMPORTANT]
> Locked out? `node server/index.js mode open --data <folder>` lets anyone sign up again; switch back once you're in.

#### Debugging HTTPS and Proxy issues

If the server is reachable from other computers, put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel, or `tailscale serve` on a tailnet) and set `"trustProxy": true` in `config.json` if a proxy forwards to it.

# Contribution
Feel free to contribute to Noctyl by reporting issues and submitting pull requests and if it meets the standards it will be merged into main upon approval.

If you're interested in long-term contribution or updates on development join the [Discord Server](https://discord.gg/VmF6JfAyWv)

<div align="center">
    <p>Made with ❤️ by Charles Johnson </p>
</div>