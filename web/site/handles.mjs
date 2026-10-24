export function isPublicHandle(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 20 && !/[^A-Za-z0-9_]/.test(value);
}
