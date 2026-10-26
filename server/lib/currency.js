// Currencies. Every price is stored in the shop's base currency (SAR, in halalas) and shown to the
// customer in the currency of the delivery country, using the rates the admin keeps up to date.

import { getSetting, setSetting } from '../db.js';

export const BASE_CURRENCY = 'SAR';

// Rates = how many units of the currency for 1 SAR. Starting values; the admin edits them.
export const DEFAULT_CURRENCIES = [
  { code: 'SAR', rate: 1, decimals: 2 },
  { code: 'USD', rate: 0.2667, decimals: 2 },
  { code: 'EUR', rate: 0.245, decimals: 2 },
  { code: 'GBP', rate: 0.21, decimals: 2 },
  { code: 'AED', rate: 0.98, decimals: 2 },
  { code: 'KWD', rate: 0.082, decimals: 3 },
  { code: 'BHD', rate: 0.1005, decimals: 3 },
  { code: 'QAR', rate: 0.971, decimals: 2 },
  { code: 'OMR', rate: 0.1026, decimals: 3 },
  { code: 'EGP', rate: 12.9, decimals: 2 },
  { code: 'JOD', rate: 0.189, decimals: 3 },
  { code: 'TRY', rate: 9.1, decimals: 2 },
  { code: 'INR', rate: 22.4, decimals: 2 },
  { code: 'PKR', rate: 74.5, decimals: 2 },
  { code: 'CAD', rate: 0.365, decimals: 2 },
  { code: 'AUD', rate: 0.40, decimals: 2 },
  { code: 'JPY', rate: 40.5, decimals: 0 },
];

export const COUNTRY_CURRENCY = {
  SA: 'SAR', AE: 'AED', KW: 'KWD', BH: 'BHD', QA: 'QAR', OM: 'OMR', EG: 'EGP', JO: 'JOD', TR: 'TRY', IN: 'INR', PK: 'PKR',
  GB: 'GBP', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', SE: 'EUR', US: 'USD', CA: 'CAD', AU: 'AUD', JP: 'JPY',
};

export function currencies() {
  return getSetting('currencies', DEFAULT_CURRENCIES);
}

export function saveCurrencies(list) {
  setSetting('currencies', list);
}

export function currencyFor(country) {
  const list = currencies();
  const code = COUNTRY_CURRENCY[String(country || '').toUpperCase()] || getSetting('fallback_currency', 'USD');
  return list.find((c) => c.code === code) || list.find((c) => c.code === BASE_CURRENCY) || DEFAULT_CURRENCIES[0];
}

// Base halalas → amount in the display currency (a number with the currency's decimals).
export function convert(baseCents, currency) {
  const amount = (baseCents / 100) * (currency.rate || 1);
  const f = 10 ** (currency.decimals ?? 2);
  return Math.round(amount * f) / f;
}
