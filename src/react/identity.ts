// Persistent per-browser identity: a stable user ID and an editable display name.

const adjectives = ["Blue", "Red", "Swift", "Quiet", "Bold", "Warm", "Cool", "Wild", "Bright", "Dark"];
const animals = ["Fox", "Owl", "Wolf", "Deer", "Bear", "Hawk", "Lynx", "Hare", "Crow", "Dove"];

function key(prefix: string, name: string) {
  return `${prefix}-${name}`;
}

function read(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}

function write(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* private mode etc. */ }
}

export function getOrCreateUserId(prefix: string): string {
  const k = key(prefix, "userId");
  let id = read(k);
  if (!id) { id = crypto.randomUUID(); write(k, id); }
  return id;
}

export function randomDisplayName(): string {
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const b = animals[Math.floor(Math.random() * animals.length)];
  return `${a} ${b}`;
}

export function getOrCreateDisplayName(prefix: string): string {
  const k = key(prefix, "displayName");
  let name = read(k);
  if (!name) { name = randomDisplayName(); write(k, name); }
  return name;
}

export function saveDisplayName(prefix: string, name: string) {
  write(key(prefix, "displayName"), name);
}
