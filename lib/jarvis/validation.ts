export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export function safeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'upload';
}
export function messageText(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000) {
    throw new Error('Enter a message between 1 and 32,000 characters.');
  }
  return value.trim();
}
export function validId(value: string) { return /^[a-zA-Z0-9_-]{1,160}$/.test(value); }
