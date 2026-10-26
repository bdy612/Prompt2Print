// Printer drivers: one object per printer with status()/start()/pause()/resume()/cancel()/test().
// `printer` fields used: url (address), serial, access_code / api_key, id.
import { octoprintDriver } from './octoprint.js';
import { moonrakerDriver } from './moonraker.js';
import { bambuDriver } from './bambu.js';
import { prusalinkDriver } from './prusalink.js';

export const DRIVERS = {
  octoprint: { label: 'OctoPrint', create: octoprintDriver, file: 'gcode' },
  moonraker: { label: 'Klipper (Moonraker)', create: moonrakerDriver, file: 'gcode' },
  bambu: { label: 'Bambu Lab (LAN mode)', create: bambuDriver, file: '3mf' },
  prusalink: { label: 'PrusaLink', create: prusalinkDriver, file: 'gcode' },
};

export function createDriver(printer) {
  const d = DRIVERS[printer.driver];
  if (!d) throw new Error(`Unknown printer driver "${printer.driver}"`);
  return d.create(printer);
}
