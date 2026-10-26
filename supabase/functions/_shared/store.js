// Storage helpers: private model files, public media.
export async function putObject(db, bucket, path, bytes, contentType) {
  const { error } = await db.storage.from(bucket).upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage ${bucket}/${path}: ${error.message}`);
}
export async function getObject(db, bucket, path) {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error) throw new Error(`storage ${bucket}/${path}: ${error.message}`);
  return new Uint8Array(await data.arrayBuffer());
}
export function mediaUrl(path) {
  return `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/media/${path}`;
}
