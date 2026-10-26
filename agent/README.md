# Prompt2Print print agent

The one part of Prompt2Print that runs on a computer: a small program on the PC that sits next to
your printers. It watches the cloud (Supabase) for paid orders, picks a printer, slices the model and
starts the print over your Wi-Fi/LAN, then reports progress back so customers see
*In print queue → Printing → Printed* in the app.

Nothing else is needed on that PC: no database, no web server, no app window.

## Run it on Windows

1. Install **Node.js 22 LTS** from https://nodejs.org (next, next, finish).
2. Copy the `agent` folder somewhere permanent (e.g. `C:\Prompt2PrintAgent`).
3. Copy `config.example.json` to `config.json` and paste:
   - `SUPABASE_URL` — `https://jxdwvzqruqdeksscazae.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase dashboard → Project Settings → API → *service_role* key.
     **This key gives full access to the shop. It stays on this PC only; never put it in the apps, on
     GitHub or in a chat.**
   - optional `BAMBU_STUDIO_PATH` / `SLICER_PATH` if the helper app is installed somewhere unusual.
4. Double-click **`start-agent.bat`**. Leave the window open (it restarts itself if it ever stops).
   The log is in `%LOCALAPPDATA%\Prompt2PrintAgent\agent.log`; sliced files and downloaded models are
   kept next to it.

To start it automatically with Windows: press Win+R, type `shell:startup`, and put a shortcut to
`start-agent.bat` in that folder.

## Printers

Add printers in the app (Admin → Printers). Choosing the **type** fills in the bed size, nozzle,
temperatures, number of AMS slots, how the agent talks to it, and which helper app to install:

| Type | What the printer needs | Helper app on this PC |
|---|---|---|
| Bambu Lab P2S / P1S / X1C / A1 / A1 mini | Printer screen → Settings → Network: **LAN mode ON** and **Developer mode ON**. Enter the IP, serial number and LAN access code. | **Bambu Studio** (https://bambulab.com/en/download/studio) — the agent slices with it in the background (proper Bambu `.3mf` jobs). Without it, the built-in slicer makes plain G-code. |
| Prusa MK4S / CORE One | Printer screen → Settings → Network → **PrusaLink**: enable it and copy the API key. Enter `http://<ip>` and the key. | **PrusaSlicer** (https://www.prusa3d.com/page/prusaslicer_424/) for best quality; built-in slicer otherwise. |
| Creality K1C / K1 Max, any Klipper printer | **Moonraker** reachable on the network (root access on Creality). Enter `http://<ip>:7125`. | **OrcaSlicer** or **PrusaSlicer** (the agent uses the PrusaSlicer-compatible command line); built-in slicer otherwise. |
| Any printer with OctoPrint | OctoPrint running, an API key. Enter `http://<ip>` and the key. | PrusaSlicer or built-in. |

Each printer must have its **slots** set to what is actually loaded (material + colour). A job only
starts on a printer that has the job's material and colour loaded, prints that material, is active,
and whose bed fits the part (with 5 mm margin). When more than one printer qualifies, the **smallest**
bed wins, so small parts go to the small printer and the big printer stays free for big parts.
One job per printer at a time.

If no printer qualifies, the job waits and the reason is shown in Admin → Print queue
(e.g. *no printer has ABS red loaded*).

**Test connection** in Admin → Printers asks the agent to talk to the printer; the result appears
under the printer within a few seconds (the agent must be running).

## What it does, step by step

1. Every 5 s: read active printers and queued `print_jobs` from Supabase.
2. Choose a printer (rules above), mark the job `slicing`.
3. Download the model's STL from the private `models` bucket (cached locally).
4. Slice: Bambu Studio CLI (`.3mf`) for Bambu printers, PrusaSlicer CLI for the others, or the built-in
   slicer. Settings: 0.2 mm layers, 5 walls, 30–40 % gyroid infill (the customer's choice), supports
   only when the model needs them.
5. Start the print (Bambu: FTPS upload + MQTT `project_file` with the AMS slot; PrusaLink: upload to
   USB with *Print-After-Upload*; Moonraker/OctoPrint: upload + print).
6. Poll the printer, write `progress`, and when it finishes mark the job `done`. Order status becomes
   `printing` when the first part starts and `printed` when every part is done.
7. Failures are retried up to 3 times (different printer if possible), then the job is `failed` and
   the order is flagged for attention.

## Files

```
agent/index.js            the agent (loop, dispatch, status, order updates)
agent/lib/rest.js         Supabase REST + Storage calls (fetch only)
agent/lib/select.js       printer choice rules
agent/lib/slice.js        slicing (Bambu Studio / PrusaSlicer / built-in)
agent/lib/drivers/        bambu, prusalink, moonraker, octoprint
agent/lib/mesh, slicer/   built-in slicer and STL reader
agent/config.example.json
agent/start-agent.bat
tests/agent.test.js       npm test
```
