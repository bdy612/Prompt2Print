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
server/      application server (no npm packages)
public/      web interface (HTML, CSS, JavaScript, Three.js viewer)
tests/       npm test
packaging/   Windows launcher, icon and installer definition; scripts/build-windows.sh builds the .msi
docs/        download website
```

Run from source: install Node.js 22.13 or newer, then `npm start` and open http://127.0.0.1:3939.
