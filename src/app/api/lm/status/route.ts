import { connection } from 'next/server';
import { lmAuthHeader } from '@/lib/lantmateriet';

/** Tells the client whether Lantmäteriet downloads are configured (without revealing anything else). */
export async function GET() {
  await connection(); // read .env.local at request time, not at build time
  return Response.json({ lantmateriet: lmAuthHeader() !== null });
}
