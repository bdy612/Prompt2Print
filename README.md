# Prompt2Print

Describe an object, see it in 3D, and it is printed and shipped to you.

Prompt2Print is a marketplace for 3D-printed products. Customers can buy items from the catalog or
describe something new: **AI Create** turns the description into a 3D model they can rotate, resize
and price instantly. Every item is printed to order after purchase and delivered.

- English and Arabic (right-to-left), works on phones and desktops
- One final price in the customer's currency, including delivery to their country
- Materials chosen by the customer: ABS (standard) and ASA (outdoor), in the colours in stock
- Built to last: minimum 2 mm walls, rounded compact shapes, fragile designs flagged before ordering
- Not for food or drink: nothing printed is food-safe (no microwave, oven or dishwasher)

## Download

Windows installer: https://bdy612.github.io/Prompt2Print/

## Project layout

```
public/      the app (HTML, CSS, JavaScript, Three.js viewer) — a client of the Supabase backend
supabase/    database schema, API contract and Edge Functions
agent/       print agent that runs on the PC next to the printers
packaging/   Windows launcher, icon and installer definition; scripts/build-windows.sh builds the .msi
docs/        download website
server/      previous local-server version (kept for reference; not shipped)
```

Run from source: install Node.js 22.13 or newer, `npm install`, then `npm run build:app` and open
`app-dist/index.html` (double-click, or `npx serve app-dist`). The Windows installer is built with
`npm run build:windows` (Linux/WSL, see the script for the tools it needs).
