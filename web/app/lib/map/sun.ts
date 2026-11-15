// Where the sun is for a place, a season and a clock time, and what "now" is there.
// Accurate to a fraction of a degree, which is plenty for lighting.

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: Season[] = ['spring', 'summer', 'autumn', 'winter'];

/** A typical day for each season (northern hemisphere; flipped south of the equator). */
const SEASON_DAY: Record<Season, [month: number, day: number]> = {
  spring: [4, 25], summer: [7, 1], autumn: [10, 12], winter: [1, 20],
};
const SOUTH_FLIP: Record<Season, Season> = { spring: 'autumn', summer: 'winter', autumn: 'spring', winter: 'summer' };

/**
 * Hours ahead of UTC for local clock time on a date (month 1–12): the time zone from the longitude, plus summer
 * time from April to October (October to March south of the equator) outside the tropics. Close enough for a
 * lighting control; real zone borders and changeover days can differ by an hour.
 */
export function utcOffset(lat: number, lon: number, month: number) {
  const summer = lat >= 0 ? month >= 4 && month <= 10 : month >= 10 || month <= 3;
  return Math.round(lon / 15) + (Math.abs(lat) > 30 && summer ? 1 : 0);
}

/** The UTC instant for a season's typical day at `hour` (local clock time, 0–24) at a place. */
export function instant(lat: number, lon: number, season: Season, hour: number) {
  const [m, d] = SEASON_DAY[lat < 0 ? SOUTH_FLIP[season] : season];
  const year = new Date().getUTCFullYear();
  return new Date(Date.UTC(year, m - 1, d) + (hour - utcOffset(lat, lon, m)) * 3600_000);
}

/** The current season and local clock hour at a place. */
export function now(lat: number, lon: number): { season: Season; hour: number } {
  const t = new Date(), m = t.getUTCMonth() + 1;
  let season: Season = m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter';
  if (lat < 0) season = SOUTH_FLIP[season];
  const hour = (t.getUTCHours() + t.getUTCMinutes() / 60 + utcOffset(lat, lon, m) + 48) % 24;
  return { season, hour };
}

/** Sun elevation above the horizon and azimuth clockwise from north, both in degrees. */
export function sunPosition(lat: number, lon: number, date: Date) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400_000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = (gmst * 15 + lon) * rad - ra, phi = lat * rad;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuth = Math.atan2(-Math.sin(H) * Math.cos(dec), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H));
  return { elevation: elevation / rad, azimuth: ((azimuth / rad) + 360) % 360 };
}

/** "14:30" */
export const clock = (hour: number) => {
  const m = Math.round(hour * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
