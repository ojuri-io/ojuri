# Windows setup guide

The main [`README.md`](../README.md) quick start assumes a POSIX shell
(macOS/Linux). This guide is the Windows equivalent: cmd / PowerShell
commands, the Windows-specific gotchas, and the exact fixes for the errors
Windows users hit most often.

If you're on macOS or Linux, you do not need this file — follow the README.

---

## Prerequisites

Install these once. The order matters: the Python installer must run after
`py` is available, and the VC++ redistributable must be present before the
first `python -m src.main` for any service that loads XGBoost or ONNX.

1. **Docker Desktop for Windows** — https://www.docker.com/products/docker-desktop/
   Launch it and wait until the whale icon in the tray shows "Docker Desktop is running".
   Verify:
   ```cmd
   docker info
   ```
   If this errors with `error during connect`, Docker isn't running yet —
   open Docker Desktop and wait for it to finish starting before retrying.

2. **Python 3.11** (not 3.12, 3.13, or 3.14) — https://www.python.org/downloads/release/python-3119/
   Download the **Windows installer (64-bit)** and tick both:
   - **Add python.exe to PATH**
   - **py launcher**

   The MLA and FIA services pin native deps (xgboost, onnx 1.13.0,
   psycopg2-binary 2.9.9) that do **not** publish wheels for Python 3.12+.
   On 3.14 you will see `pg_config executable not found` (pip falling back
   to source build) and on any non-3.11 you will eventually hit
   `xgboost.dll could not be loaded` or onnx import failures. There is no
   workaround other than installing 3.11.

   Verify:
   ```cmd
   py -3.11 --version
   ```
   Must print `Python 3.11.x`. If `py -3.11` prints any other version, 3.11
   isn't installed — re-run the installer.

3. **Microsoft Visual C++ Redistributable (2015–2022, x64)** —
   https://aka.ms/vs/17/release/vc_redist.x64.exe
   XGBoost's wheel on Windows links against the MSVC runtime
   (`vcomp140.dll`, `vcruntime140.dll`). Without it you'll see
   `XGBoostError: XGBoost Library (xgboost.dll) could not be loaded` the
   first time MLA tries to train or score. Install, then **reboot** (the
   DLLs are only picked up by new processes after the reboot).

4. **Node.js 20.x LTS** — https://nodejs.org/ (only if you'll run the
   frontend or RDA outside Docker).

5. **Git for Windows** — https://git-scm.com/download/win
   Use the bundled "Git Bash" terminal if you'd prefer POSIX syntax for
   the activation commands below; everything else in this guide uses cmd.

---

## Quick start (Windows cmd)

```cmd
git clone https://github.com/ojuri-io/ojuri.git
cd ojuri
copy .env.example .env
docker compose up -d
npm install
npm run db:migrate
```

Notes:
- `copy` (cmd) replaces `cp` (POSIX). PowerShell users: `Copy-Item .env.example .env`.
- `docker compose up -d` will fail with `Cannot connect to the Docker
  daemon` if Docker Desktop isn't running — start it from the Start menu
  and wait for the tray icon.
- The first build pulls ~2 GB and takes several minutes; subsequent
  `up -d` runs are instant.

---

## MLA (Python service) on Windows

MLA runs on the host venv, not in Compose. From the repo root:

```cmd
cd mla-service
py -3.11 -m venv venv
venv\Scripts\activate.bat
python --version
```

`python --version` must print `Python 3.11.x`. If it doesn't, the venv was
created with the wrong interpreter — `deactivate`, `rmdir /s /q venv`, and
re-run with the correct `py -3.11` invocation.

Then:

```cmd
python -m pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
python -m src.main
```

PowerShell users substitute the activation line:

```powershell
venv\Scripts\Activate.ps1
```

If PowerShell blocks the activation script with
`running scripts is disabled on this system`, allow local user scripts
once with:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

---

## FIA (Python LLM service) on Windows

Same pattern as MLA, but the venv directory is `.venv` (with the dot) per
the project convention, and the first run downloads ~7.6 GB of Phi-3
weights to `%USERPROFILE%\.cache\huggingface`:

```cmd
cd fia-service
py -3.11 -m venv .venv
.venv\Scripts\activate.bat
pip install -r requirements.txt
python -m src.main
```

Apple Silicon's MPS device path does not apply on Windows — FIA will pick
CUDA if you have an NVIDIA GPU with a recent CUDA toolkit installed,
otherwise CPU. Expect 2–5 minutes per report on CPU.

---

## Common Windows errors and fixes

### `'source' is not recognized as an internal or external command`
`source` is a POSIX shell builtin and doesn't exist in cmd or PowerShell.
Use `venv\Scripts\activate.bat` (cmd) or `venv\Scripts\Activate.ps1`
(PowerShell) instead.

### `'venv' is not recognized as an internal or external command`
The `venv` directory hasn't been created yet, or you're not in the
service directory. Run `dir venv` — you should see a `Scripts\` folder
inside. If you don't, `py -3.11 -m venv venv` first.

### `pg_config executable not found`
pip is falling back to building `psycopg2-binary` from source because no
prebuilt wheel matches your Python version. Always means the active
interpreter is **not 3.11**. Confirm with `python --version` inside the
venv. If it's 3.12+, delete the venv and recreate with `py -3.11 -m venv venv`.

### `XGBoost Library (xgboost.dll) could not be loaded`
Microsoft Visual C++ Redistributable is missing. Install
https://aka.ms/vs/17/release/vc_redist.x64.exe and reboot. If the error
persists after reboot, also verify your Python is 3.11 — older xgboost
versions sometimes ship 3.11-only Windows wheels.

### `Cannot connect to the Docker daemon`
Docker Desktop isn't running. Start it from the Start menu and wait for
the tray icon to stabilise before retrying `docker compose up -d`.

### `Microsoft Visual C++ 14.0 or greater is required`
Same root cause as `pg_config executable not found` — pip is trying to
compile a native extension from source because no wheel matches. Don't
install Visual Studio Build Tools; instead fix the Python version so a
wheel matches.

### PowerShell: `running scripts is disabled on this system`
Allow local user scripts once:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

---

## What lives where (Windows path equivalents)

| README path              | Windows equivalent                          |
|--------------------------|---------------------------------------------|
| `~/.cache/huggingface`   | `%USERPROFILE%\.cache\huggingface`          |
| `source venv/bin/activate` | `venv\Scripts\activate.bat` (cmd) or `Activate.ps1` (PowerShell) |
| `cp .env.example .env`   | `copy .env.example .env` (cmd) or `Copy-Item` (PowerShell) |
| `rm -rf venv`            | `rmdir /s /q venv`                          |
| `cd ../models`           | `cd ..\models` (forward slashes also work in most shells) |

Everything else in the README (npm scripts, docker compose commands,
URLs, env-var names) is the same on Windows.
