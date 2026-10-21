/** Specialist roles that can be used as built-in or derived agent bases. */
export const SUPPORTED_SPECIALIST_ROLES = [
  'explorer',
  'oracle',
  'designer',
  'fixer',
  'observer',
] as const;

export type SpecialistRole = (typeof SUPPORTED_SPECIALIST_ROLES)[number];
