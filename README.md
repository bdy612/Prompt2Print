# Prompt2Print

A marketplace for 3D-printed products, like a small Amazon, where every item is printed to order on
a **Bambu Lab P2S** in **ABS** or **ASA**. Customers can buy catalog items or describe something new:
**AI Create** turns the prompt into a 3D model they can rotate, resize and price instantly. After
payment, the order is sliced, queued and sent to the printer automatically.

English and Arabic (right-to-left), mobile friendly, prices in the customer's currency, no external
libraries to install.

---

## Run it on Windows

**Download:** https://bdy612.github.io/Prompt2Print/ (direct link:
[Prompt2Print-Setup-1.1.0.msi](https://github.com/bdy612/Prompt2Print/raw/main/docs/Prompt2Print-Setup-1.1.0.msi)).

**Option A: the installer (recommended).** Double-click `Prompt2Print-Setup-1.1.0.msi`, then open
**Prompt2Print** from the Start menu or desktop. It opens in its own window. The first start takes
about 30 seconds while it creates the catalog and product photos. Nothing else is needed: the
installer contains the app and its runtime.

- Windows shows "Windows protected your PC" because the installer isn't code-signed yet
  (click **More info → Run anyway**). See *Code signing* below to remove that warning.
- Shop data is kept in `%LOCALAPPDATA%\Prompt2Print` and survives updates and uninstalls.

**Option B: from the source folder.** The installer puts the complete, unminified source in
`C:\Program Files\Prompt2Print\app` (server, web app, tests, build scripts, packaging). Copy it
anywhere, install [Node.js](https://nodejs.org) 22.13 or newer, then double-click `start-dev.bat`
(or `npm start`) and open http://127.0.0.1:3939. Run the tests with `npm test`; rebuild the
installer on Linux/WSL with `scripts/build-windows.sh`.

### Admin sign-in

The only account that exists on first start is the admin, **Prompt2Print.admin@gmail.com**. Its
password is not in the source or the installer: the first time you open **Sign in**, the app asks you
to set it (this works only from the computer that runs the shop, and only once). To skip that step,
put `P2P_ADMIN_PASSWORD=…` in a `.env` file before the first start. Change it later under
Account → Change password. Customers create their own accounts. There are no demo accounts, no
sample orders and no test cards.

---

## Shop rules built into the app

**Not for food or drink.** Nothing printed is food-safe. The app refuses prompts for cups, plates,
bottles, utensils, baby items, lunch boxes and similar (English and Arabic), there are no such items
in the catalog, and every product page, AI Create page, cart and checkout shows:

> Not for food or drink. Do not microwave, bake, or dishwash. Heat-resistant up to ~85°C (ABS) /
> ~100°C (ASA). Keep away from open flame.

**Printer.** One Bambu Lab P2S Combo (AMS 2 Pro, 4 spools). Models must fit inside
250 × 250 × 250 mm; anything larger is refused or scaled down. Material temperatures are capped at
the printer's limits (nozzle 300 °C, bed 110 °C).

**Materials.** ABS (default, 0.11 SAR/g) and ASA (outdoor, 0.16 SAR/g), 1 kg Bambu spools. Colours
are an editable list with an **in stock** switch per colour (start: 6 ABS + 2 ASA). Only colours in
stock are offered, and a job only starts when its colour is loaded in an AMS slot
(Admin → Printers → AMS slots).

**Durability.** Minimum wall thickness 2 mm (checked on every model at the chosen size), printed with
5 walls and 30–40 % gyroid infill (customers choose within that range). Models that are thin or
long-and-thin get a warning, and sizes that would make walls thinner than 2 mm are blocked. AI
services are asked for rounded, compact shapes with no thin spikes, and models are turned to the
orientation that needs the least support. The app never promises "unbreakable".

---

## How prices work

Everything is calculated in Saudi riyals and shown in the currency of the delivery country
(rates under Admin → Settings → Currencies):

1. **Item price** = model weight (g) × price per gram of the material (weight from volume, infill,
   walls and density: this maths runs on the server and is not shown to customers).
2. **Tax** = rate for the country/region × item price.
3. **Shipping** = zone base + per-kg × billable weight (real or volumetric, 0.5 kg steps).
4. **Subtotal** = item + tax + shipping.
5. **Service fee** = 15 % up to 375 SAR (≈ $100), 5 % above (editable tiers).
6. **Total** = subtotal + fee.

The breakdown (item, tax, shipping, fee, total) is shown on the product page, AI Create, the cart
and checkout, and recalculated live when size, material, infill, colour or country change.

## Payments (Tap Payments)

Tap accepts Visa, Mastercard, American Express, Apple Pay and mada from customers anywhere in the
world, and settles to a Saudi account. Sign up at tap.company (commercial registration or a freelance
document), then paste the secret key under **Admin → Settings → Payments**. The customer is charged in
their own currency; the amount is verified against the order before printing starts. Until a key is
entered, orders can't be placed.

## AI Create

- With a **Meshy** or **Tripo** key (Admin → Settings, or `TRIPO_API_KEY` in `.env`; keys are moved
  into the encrypted vault on first start), prompts become real AI models. Each model is repaired,
  auto-oriented, scaled to the printer limit and checked for walls, size and supports.
  Tripo charges credits per model: top up at platform.tripo3d.ai → Billing. If the service refuses
  (no credits, wrong key, offline), the built-in generator makes the model instead and the reason
  is written to the server log.
- Without a key, the built-in generator makes stylised shapes from keywords (pen holders, vases,
  planters, chess pieces, figurines, organizers…). This also builds the starting catalog.
- The model file never leaves the server. The viewer gets a reduced preview for the owner only.

## Printing

After payment each copy becomes a job: it is sliced (with **Bambu Studio** when installed on the
PC, otherwise the built-in slicer), waits for a free printer with the right colour loaded, is sent
over the LAN (MQTT + FTPS) and starts. Order status moves automatically:
Paid → In print queue → Printing → Printed, then staff mark Packed → Shipped (tracking) → Delivered.

Printer setup: Admin → Printers → the P2S → enter its IP, serial number and LAN access code
(Printer settings → Network → LAN mode, developer mode on), set the 4 AMS slots, activate.
Printers can be added or removed freely.

## Security

- Passwords hashed with scrypt; sign-in throttled after repeated failures.
- Admin sessions expire after 12 h or 60 min of inactivity; every admin sign-in and settings change
  is written to an audit log.
- API keys and payment keys are encrypted (AES-256-GCM) with a master key stored outside the
  database (`data/.master.key`). Copying the database alone does not reveal them.
- Model files and print files live in a private folder the web server never serves; previews go
  only to their owner. CSRF header check, strict Content-Security-Policy, no demo accounts.
- The app listens only on your own PC (127.0.0.1). When you put it online, run it behind HTTPS and
  set `P2P_PUBLIC_URL`.

## Code signing (removes the Windows warning)

Buy a code-signing certificate (Azure Trusted Signing, or an OV/EV certificate from Sectigo,
DigiCert or SSL.com), export it as `.pfx`, and build with:

```
P2P_SIGN_PFX=/path/cert.pfx P2P_SIGN_PASS=secret scripts/build-windows.sh
```

Both `Prompt2Print.exe` and the `.msi` are then signed automatically.

## Project layout

```
server/            Node.js server (no npm packages; built-in SQLite)
  pricing/         pricing engine and quotes
  mesh/            model reading, analysis (walls, overhangs, size), repair, preview, photo renderer
  ai/              AI providers (Meshy, Tripo, built-in generator)
  printing/        queue, slicers (built-in, Bambu Studio, PrusaSlicer), printer drivers
  payments/        Tap Payments and Stripe
  lib/secrets.js   encrypted settings
public/            web app (HTML, CSS, JavaScript, Three.js viewer)
tests/             npm test
packaging/         Windows launcher, icon, MSI definition; scripts/build-windows.sh builds the .msi
```
