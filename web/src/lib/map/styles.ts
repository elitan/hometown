import { rand } from './geo';

export type MapStyle = 'illustrated' | 'hybrid' | 'satellite';

export const ROAD: Record<string, [number, string]> = {
  motorway: [12, '#555'], trunk: [11, '#555'], primary: [10, '#5b5b5b'], secondary: [8, '#666'], tertiary: [7, '#6e6e6e'],
  residential: [6, '#7a7a7a'], unclassified: [5.5, '#7a7a7a'], living_street: [5, '#848484'], service: [3.5, '#888'],
  track: [3, '#b59a6b'], footway: [1.8, '#d8c7a0'], path: [1.6, '#d2bf93'], cycleway: [2, '#c9b58a'], pedestrian: [3, '#cfc6b3'],
};
export const UNPAVED = new Set(['track', 'footway', 'path', 'cycleway', 'pedestrian', 'bridleway', 'steps']);
export const LAND: Record<string, string> = {
  forest: '#5f8a4a', wood: '#5f8a4a', meadow: '#9cc46e', grass: '#9fc874', park: '#86b860', pitch: '#7fbf5f', garden: '#94c06c',
  residential: '#b3c79a', cemetery: '#8fae78', orchard: '#a3c46c', allotments: '#a5c27a', grassland: '#9cc46e',
  wetland: '#8fb08a', scrub: '#93a868', heath: '#93a868', farmyard: '#c2b48f', industrial: '#b9b3a6',
};
export const LAND_ORDER: Record<string, number> = { residential: 0, farmland: 1, industrial: 1, farmyard: 2 };
export const FIELDS = ['#d8c58b', '#c9d48a', '#e4d77a', '#b9c97d', '#d2be7c'];
export const WALLS = ['#f4f1ea', '#efe3bf', '#a8452e', '#f2e6c9', '#ddd6c8', '#e9d9a6'];
export const ROOFS = ['#6e6a66', '#8a3b2b', '#5a5653', '#7b4a3a'];
export const WATER = '#5a9ec9';
export const GROUND = '#8fb36b';
export const PLACE_KINDS = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'locality', 'isolated_dwelling', 'farm']);

export function buildingHeight(t: Record<string, string>) {
  const h = parseFloat(t.height);
  if (h > 0) return h;
  const lv = parseFloat(t['building:levels']);
  if (lv > 0) return lv * 3 + 1;
  const byType: Record<string, number> = {
    garage: 3, garages: 3, shed: 2.6, carport: 2.6, barn: 8, farm_auxiliary: 7, church: 14, apartments: 12,
    industrial: 8, warehouse: 8, school: 8, greenhouse: 3.5,
  };
  return byType[t.building] ?? rand(5.5, 7.5);
}

export const pretty = (s?: string) => s ? (s[0].toUpperCase() + s.slice(1)).replace(/_/g, ' ') : '';
