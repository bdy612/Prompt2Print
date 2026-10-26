import { simulatorDriver } from './simulator.js';
import { octoprintDriver } from './octoprint.js';
import { moonrakerDriver } from './moonraker.js';
import { bambuDriver } from './bambu.js';

export const DRIVERS = {
  simulator: { label: 'Simulated printer', create: simulatorDriver, fields: [] },
  octoprint: { label: 'OctoPrint', create: octoprintDriver, fields: ['url', 'api_key'] },
  moonraker: { label: 'Klipper (Moonraker)', create: moonrakerDriver, fields: ['url', 'api_key'] },
  bambu: { label: 'Bambu Lab (LAN mode, beta)', create: bambuDriver, fields: ['url', 'serial', 'access_code'] },
};

export function createDriver(printer) {
  const d = DRIVERS[printer.driver];
  if (!d) throw new Error(`Unknown printer driver "${printer.driver}"`);
  return d.create(printer);
}
