// Shared client state.
export const state = {
  boot: null,          // /api/bootstrap response
  user: null,
  destination: { country: 'SA', region: '' },
  cartCount: 0,
  display: { currency: 'SAR', rate: 1, decimals: 2 },   // currency shown to the customer
};

const DEST_KEY = 'p2p_destination';
export function loadSavedDestination() {
  try { return JSON.parse(localStorage.getItem(DEST_KEY) || 'null'); } catch { return null; }
}
export function saveDestination(d) {
  state.destination = d;
  try { localStorage.setItem(DEST_KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
}
export const destQuery = () => ({ country: state.destination.country, region: state.destination.region, addressId: state.destination.addressId });
