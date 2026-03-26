# How to Run Chat With Co on Windows
## (Step-by-step — takes about 3 minutes)

---

## Step 1 — Install Python

1. Go to **https://www.python.org/downloads/**
2. Click the big yellow **Download Python** button
3. Run the installer
4. ⚠️ **IMPORTANT:** On the first screen, tick the box that says **"Add Python to PATH"**
5. Click **Install Now**

To verify it worked, open PowerShell and type:
```
python --version
```
You should see something like `Python 3.12.x`

---

## Step 2 — Set up your project folder

Your folder should look like this:
```
chat with co\
├── server.py
├── START_SERVER.bat       ← double-click this to start
├── requirements.txt
└── static\
    └── index.html
```

If the `static` folder doesn't exist yet, create it and move `index.html` into it.

---

## Step 3 — Start the server

**Option A — Easiest (double-click):**
Double-click `START_SERVER.bat`

**Option B — From PowerShell / Command Prompt:**
```powershell
cd "C:\Users\abhin\OneDrive\Desktop\chat with co"
pip install websockets
python server.py
```

You should see:
```
Database ready: ...
WebSocket server  →  ws://localhost:8081
HTTP server  →  http://localhost:8080
```

---

## Step 4 — Open the app

Open your browser and go to:
```
http://localhost:8080
```

---

## Step 5 — Test with two users

To test real messaging between two users on the **same computer**:
1. Open **Chrome** → go to `http://localhost:8080` → Register as **Alice**
2. Open **Microsoft Edge** (or an Incognito window) → go to `http://localhost:8080` → Register as **Bob**
3. Alice adds Bob's phone number as a contact
4. Bob adds Alice's phone number as a contact
5. Start chatting — messages appear instantly in both windows

To chat from **another device** on the same Wi-Fi:
1. Find your PC's local IP address — open PowerShell and type `ipconfig`, look for **IPv4 Address** (e.g. `192.168.1.5`)
2. On the other device, open browser and go to `http://192.168.1.5:8080`

---

## Fixing the VS Code error you saw

The error `/usr/bin/env is not recognized` happened because VS Code's **Run** button used a Linux-style command. Fix it one of two ways:

**Fix 1 — Run from terminal inside VS Code:**
Press `` Ctrl+` `` to open the terminal, then type:
```powershell
python server.py
```

**Fix 2 — Configure VS Code run button for Python:**
1. Press `F1` → type `Python: Select Interpreter` → choose your Python installation
2. Then press `F5` or use Run → Start Debugging

---

## If `websockets` install fails

Run this in PowerShell as Administrator:
```powershell
pip install websockets --user
```

---

## Stopping the server

Press **Ctrl+C** in the terminal/PowerShell window where the server is running.
