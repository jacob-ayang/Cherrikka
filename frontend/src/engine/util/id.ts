import { validate as uuidValidate, v4 as uuidv4, v5 as uuidv5 } from 'uuid';

const NAMESPACE = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

export function newId(): string {
  return uuidv4();
}

export function ensureUUID(candidate: string, seed: string): string {
  if (uuidValidate(candidate)) return candidate;
  return uuidv5(seed || uuidv4(), NAMESPACE);
}
