/**
 * Friendly display names for synthetic guests. Purely cosmetic: derived deterministically from
 * the agent id (and group id for a shared family name), so the map label and the side panel
 * always agree and a guest keeps the same name across reloads. Never sent to the Engine.
 */
import type { Id } from '../../contract/behavior-v1';

const FIRST = [
  'Ava', 'Ben', 'Chloe', 'Diego', 'Elena', 'Felix', 'Grace', 'Hiro', 'Isla', 'Jonah', 'Kira', 'Leo',
  'Maya', 'Nico', 'Olive', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tara', 'Umar', 'Vera', 'Wes', 'Ximena',
  'Yusuf', 'Zoe', 'Arjun', 'Bea', 'Caleb', 'Dana', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'June',
  'Kofi', 'Lena', 'Miles', 'Nora', 'Omar', 'Pia', 'Ravi', 'Sofia', 'Theo', 'Uma', 'Victor', 'Wren',
  'Aiko', 'Bruno', 'Clara', 'Dev', 'Esme', 'Finn', 'Gemma', 'Hugo', 'Ines', 'Jade', 'Kai', 'Lucia',
  'Marco', 'Nadia', 'Oscar', 'Paloma', 'Rhys', 'Sana', 'Tomas', 'Valentina', 'Will', 'Yara', 'Zane',
];
const LAST = [
  'Alvarez', 'Bennett', 'Chen', 'Dubois', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ito', 'Jensen',
  'Kim', 'Lopez', 'Moreau', 'Nakamura', 'Okafor', 'Patel', 'Quintero', 'Rossi', 'Silva', 'Tanaka',
  'Usman', 'Vargas', 'Walsh', 'Xu', 'Young', 'Zhang', 'Abbott', 'Brooks', 'Costa', 'Diaz', 'Ellis',
  'Ferreira', 'Gupta', 'Haddad', 'Iqbal', 'Johansson', 'Kowalski', 'Lindqvist', 'Murphy', 'Novak',
  'Oliveira', 'Park', 'Reyes', 'Schmidt', 'Torres', 'Underwood', 'Volkov', 'Wright', 'Yilmaz',
];

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** e.g. "Maya Okafor". Pass the group id so family members share a surname. */
export function guestName(agentId: Id, groupId?: Id | null): string {
  const first = FIRST[hash32(`f:${agentId}`) % FIRST.length]!;
  const last = LAST[hash32(`l:${groupId ?? agentId}`) % LAST.length]!;
  return `${first} ${last}`;
}
