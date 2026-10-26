# Prompt2Print cloud API (Supabase)

Project: `https://jxdwvzqruqdeksscazae.supabase.co` · anon key: `sb_publishable_tgBXVInAShV0zvhABrfD1g_kfC4avfS`

Clients (Windows app now; Android/iOS/macOS later) use **supabase-js** directly for auth and for
reading/writing tables under Row Level Security, and call **Edge Functions** for anything that
needs secrets or server-side truth (pricing, orders, payments, AI generation, model files).

Money: integer halalas (SAR cents) everywhere; `display` blocks convert for the customer.

## Auth
- `supabase.auth.signUp({ email, password, options: { data: { name, locale } } })` → profile row created by trigger.
- `supabase.auth.signInWithPassword`, `signOut`, `onAuthStateChange`.
- Profile: `from('profiles').select('*').eq('id', user.id).single()`; update `name`, `locale`.
- Admin = `profiles.role = 'admin'` (set by the owner in the database; cannot be self-assigned).

## Tables readable by clients (RLS)
| table | who |
|---|---|
| settings (non-secret keys) | everyone |
| currencies, country_currency, tax_rates, shipping_zones | everyone |
| categories, materials (active), products (active), printer_types | everyone |
| models | owner, catalog models, admin |
| reviews | everyone (insert own) |
| wishlist, addresses, designs, orders, order_items, order_events | own rows; admin all |
| printers, print_jobs, audit_log | admin |

Cart is kept on the device (localStorage) as lines `{ kind: 'product'|'design', productId|designId, material, color, scale, infill, quantity }`.

## Edge Functions — ONE function `api`, routed by sub-path: `https://<project>.supabase.co/functions/v1/api/<route>`
(header `Authorization: Bearer <access token or anon key>`; also send `apikey: <anon key>`). With supabase-js: `supabase.functions.invoke('api/quote', { body })`.
Extra route `rates-refresh` (POST, admin or cron) pulls currency rates and worldwide tax rates from the internet daily.

### `quote`
Request: `{ lines: [{ productId?, designId?, material, color, scale, infill, quantity }], country, region?, addressId? }`
Response:
```
{ lines: [{ ...line, title: {en, ar}, thumb, unitFilamentCents, filamentCents, weightG, sizeMm: [x,y,z], printable: bool,
            checks: [{ id, status: 'pass'|'warn'|'fail', detail }], fragile, needsSupports, maxScale, minScale, printTimeSec }],
  breakdown: { filamentCents, taxCents, taxRate: {rate,label}, shippingCents, zone: {name:{en,ar}, minDays, maxDays}, subtotalCents, feePercent, feeCents, totalCents },
  display: { currency, rate, decimals, total },
  printable, shipsToDestination, problems: [string] }
```
Errors: `400 { error: { message, code } }` (e.g. `color_out_of_stock`, `material_unknown`, `not_printable`).

### `checkout`
Auth required. Request: `{ lines, addressId, locale }`. Prices are recomputed server-side.
Response: `{ order: { id, number, status, totalCents, display, ... } }`.

### `pay`
Auth required. Request: `{ orderNumber, returnUrl }` → `{ provider: 'tap', url }` (redirect the customer to `url`).
Request: `{ orderNumber, confirm: true, tapId }` → `{ order }` after returning from Tap.
Error `payments_unconfigured` when no Tap key is stored.

### `tap-webhook` (no JWT; verified with Tap's hashstring)
Tap posts charge events here. Marks the order paid, creates print jobs.

### `designs`
Auth required.
- `{ action: 'create', prompt, parentId?, seed?, locale }` → `{ design }` (status `queued`/`generating`; poll the `designs` table, or
  `{ action: 'status', id }` → `{ design }`).
- `{ action: 'regenerate', id }` → `{ design }` (new seed).
- Food/drink prompts are refused with `400 { error: { code: 'food_prompt', message } }` (localized).
- The function calls Tripo (key in Vault), repairs, orients, scales to ≤ 250 mm, analyses walls/overhangs, stores the STL
  privately, a reduced preview and a thumbnail in `media`.

### `preview`
GET `?model=<id>` with the user's token → binary P2PV preview of the model (owner, catalog or admin only). `Cache-Control: no-store`.

### `admin`
Admin only. `{ action: 'generate', prompt, seed? }` builds a catalog model with the built-in generator (STL + photo);
`{ action: 'order', id, do: 'advance'|'cancel'|'refund'|'tracking', ... }`; `{ action: 'printer-test', id }` (asks the print agent);
`{ action: 'audit', detail }`.

## Storage
- `media` (public): product photos and design thumbnails. URL `https://<project>.supabase.co/storage/v1/object/public/media/<path>`.
- `models` (private): `models/<id>.stl`, `models/<id>.p2pv`. Only edge functions and the print agent (service role) read it.

## Print agent (runs on the PC next to the printers)
Polls `print_jobs` (service role key from its own config file), picks the smallest active printer that fits the part and has the
material + colour loaded in a slot, slices (Bambu Studio / PrusaSlicer / OrcaSlicer if installed, built-in slicer otherwise),
sends the job over the LAN, reports `status`/`progress`, and advances the order (`in_queue → printing → printed`).
