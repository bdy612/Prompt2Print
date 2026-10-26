// The cloud backend: one Supabase project shared by every Prompt2Print app (Windows now, mobile later).
// Only the publishable (anon) key lives in the app; everything sensitive is enforced by Row Level
// Security and Edge Functions on the server.
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://jxdwvzqruqdeksscazae.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_tgBXVInAShV0zvhABrfD1g_kfC4avfS';
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
export const MEDIA_URL = `${SUPABASE_URL}/storage/v1/object/public/media`;

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'p2p-auth' },
});

export async function accessToken() {
  const { data } = await sb.auth.getSession();
  return data.session?.access_token || null;
}

// Headers for direct fetches to Edge Functions (binary responses the SDK can't deliver).
export async function authHeaders() {
  const token = await accessToken();
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` };
}

// Public media url for a storage path (already-absolute urls pass through).
export function mediaUrl(p) {
  if (!p) return null;
  if (/^https?:\/\//.test(p)) return p;
  return `${MEDIA_URL}/${String(p).replace(/^\/+/, '')}`;
}
