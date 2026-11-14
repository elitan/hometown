'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalProjection, type OsmData } from '@/lib/map/geo';
import { MapEngine, type BuildStats } from '@/lib/map/engine';
import { fetchElevation, fetchImagery, fetchLaserTrees, fetchOSM, fetchSurface, geocode, type Elevation, type Imagery, type LaserTrees, type Surface } from '@/lib/map/sources';
import type { MapStyle } from '@/lib/map/styles';
import { Segmented } from './Segmented';
import { Loader, type StepKey, type StepState } from './Loader';
import { PlaceCard, type Chip } from './PlaceCard';
import { NavControls } from './NavControls';

type Loaded = { P: LocalProjection; data: OsmData; elev: Elevation | null; img: Imagery | null; laser: LaserTrees | null; surface: Surface | null; R: number; name: string };

const RADII = [{ v: 500, label: '1 km' }, { v: 1000, label: '2 km' }, { v: 1500, label: '3 km' }];
const HILLS = [{ v: 1, label: '×1' }, { v: 2, label: '×2' }, { v: 4, label: '×4' }];
const STYLES: { v: MapStyle; label: string }[] = [{ v: 'illustrated', label: 'Illustrated' }, { v: 'hybrid', label: 'Hybrid' }, { v: 'satellite', label: 'Satellite' }];
const NO_STEPS: Record<StepKey, StepState> = { geo: '', osm: '', dem: '', img: '', build: '' };
const fmt = (n: number) => n.toLocaleString('en-US');

type TreeInfo = { state: 'measuring' | 'laser' | 'estimated'; count: number; year?: string };

export default function Hometown() {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const compassRef = useRef<SVGSVGElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const loadId = useRef(0);
  const optsRef = useRef<{ hills: number; style: MapStyle }>({ hills: 2, style: 'hybrid' });
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [place, setPlace] = useState('Mala, Hässleholm');
  const [radius, setRadius] = useState(1000);
  const [hills, setHills] = useState(2);
  const [style, setStyle] = useState<MapStyle>('hybrid');
  const [busy, setBusy] = useState(false);
  const [loaderOpen, setLoaderOpen] = useState(true);
  const [steps, setSteps] = useState(NO_STEPS);
  const [error, setError] = useState('');
  const [card, setCard] = useState<{ title: string; subtitle: string; chips: Chip[] } | null>(null);
  const [trees, setTrees] = useState<TreeInfo | null>(null);
  const [hint, setHint] = useState(false);
  const [photoCredit, setPhotoCredit] = useState(false);
  const [traffic, setTraffic] = useState(true);
  const [follow, setFollow] = useState<{ name: string; kmh: number } | null>(null);

  const setStep = (k: StepKey, s: StepState) => setSteps(prev => ({ ...prev, [k]: s }));

  const hideHint = useCallback(() => { setHint(false); clearTimeout(hintTimer.current); }, []);

  const rebuild = useCallback((animate: boolean, opts: { hills: number; style: MapStyle }, measuring = false) => {
    optsRef.current = opts;
    const L = loadedRef.current, eng = engineRef.current;
    if (!L || !eng) return;
    const st: BuildStats = eng.build({ ...L, exag: opts.hills, style: opts.style }, animate);
    setPhotoCredit(!!L.img && opts.style !== 'illustrated');
    setTrees(t => st.treeSource === 'laser'
      ? { state: 'laser', count: st.trees, year: L.laser?.year }
      : { state: measuring || t?.state === 'measuring' ? 'measuring' : 'estimated', count: st.trees });
    const parts = L.name.split(',').map(s => s.trim());
    const km = (L.R * 2 / 1000).toFixed(0);
    const chips: Chip[] = [
      { color: '#a8452e', text: st.roofsMeasured ? `${fmt(st.buildings)} buildings · ${fmt(st.roofsMeasured)} roofs measured` : `${fmt(st.buildings)} buildings` },
      { color: '#8a7a5c', text: `${km} × ${km} km` },
      st.elevMin != null
        ? { color: '#5a9ec9', text: `${st.elevMin}–${st.elevMax} m above sea` }
        : { color: '#999', text: 'No elevation data' },
    ];
    if (L.elev) chips.push({ color: L.elev.source === 'lantmateriet' ? '#d9a521' : '#999', text: L.elev.source === 'lantmateriet' ? 'Terrain: Lantmäteriet 1 m' : 'Terrain: global 30 m' });
    setCard({
      title: parts[0],
      subtitle: parts.slice(1).filter(p => !/^\d[\d ]*$/.test(p)).slice(0, 2).join(' · ') || 'Custom location',
      chips,
    });
  }, []);

  const load = useCallback(async (q: string, R: number, opts: { hills: number; style: MapStyle }) => {
    q = q.trim();
    if (!q) return;
    const id = ++loadId.current;
    history.replaceState(null, '', '#' + encodeURIComponent(q));
    setBusy(true); setLoaderOpen(true); setError(''); setSteps(NO_STEPS); setCard(null); setTrees(null);
    let stage: StepKey = 'geo';
    try {
      setStep('geo', 'active');
      const [lat, lon, name] = await geocode(q);
      setStep('geo', 'done');
      const P = new LocalProjection(lat, lon), b = P.bbox(R);
      stage = 'osm';
      setSteps(s => ({ ...s, osm: 'active', dem: 'active', img: 'active' }));
      const t0 = performance.now();
      const elevP = fetchElevation(b, R).then(f => { setStep('dem', 'done'); return f; }).catch(e => { console.warn(e); setStep('dem', 'fail'); return null; });
      // Real trees (Sweden + Lantmäteriet login) are slow the first time. Don't block the map on them, and start them
      // once elevation is in: both download from Lantmäteriet and would otherwise slow each other down.
      // laser products: real trees + the height-above-ground grid that real roof shapes are measured from
      const laserP = elevP.then(() => Promise.all([fetchLaserTrees(b), fetchSurface(b).catch(() => null)]))
        .then(([trees, surface]) => ({ trees, surface }))
        .catch(e => { console.info('Estimated trees:', (e as Error).message); return null; });
      let laserDone = false;
      laserP.finally(() => { laserDone = true; console.info(`[load] laser trees at ${Math.round(performance.now() - t0)} ms`); });
      const [data, elev, img] = await Promise.all([
        fetchOSM(b).then(d => { setStep('osm', 'done'); return d; }),
        elevP,
        fetchImagery(b, R).then(f => { setStep('img', 'done'); return f; }).catch(e => { console.warn(e); setStep('img', 'fail'); return null; }),
      ]);
      stage = 'build'; setStep('build', 'active');
      await new Promise(r => setTimeout(r, 30));
      if (id !== loadId.current) return;
      // if the trees were cached they're already here: build once with them
      const ready = laserDone ? await laserP : null;
      loadedRef.current = { P, data, elev, img, laser: ready?.trees ?? null, surface: ready?.surface ?? null, R, name };
      rebuild(true, opts, !laserDone);
      console.info(`[load] map shown at ${Math.round(performance.now() - t0)} ms (elevation: ${elev?.source ?? 'none'})`);
      setStep('build', 'done');
      setTimeout(() => setLoaderOpen(false), 250);
      setHint(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(false), 9000);

      if (!laserDone) {
        const laser = await laserP;
        const L = loadedRef.current;
        if (id !== loadId.current || !L) return;
        if (!laser) { setTrees(t => t && { ...t, state: 'estimated' }); return; }
        L.laser = laser.trees; L.surface = laser.surface;
        // rebuild once with real trees and measured roofs (keeps the camera where it is)
        rebuild(false, optsRef.current);
      }
    } catch (e) {
      console.error(e);
      setStep(stage, 'fail');
      setError((e as Error).message || 'Something went wrong.');
      if (loadedRef.current) setTimeout(() => { setLoaderOpen(false); rebuild(false, opts); }, 3500);
    } finally {
      if (id === loadId.current) setBusy(false);
    }
  }, [rebuild]);

  const treeChip: Chip | null = trees && (
    trees.state === 'laser' ? { color: '#3f7a3a', text: `${fmt(trees.count)} real trees · laser ${trees.year}` }
    : trees.state === 'measuring' ? { color: '#3f7a3a', text: 'Measuring real trees…', pulse: true }
    : { color: '#3f7a3a', text: `${fmt(trees.count)} trees (estimated)` });
  const cardWithTrees = card && { ...card, chips: treeChip ? [card.chips[0], treeChip, ...card.chips.slice(1)] : card.chips };

  // engine lifecycle + first load (from URL hash if present)
  useEffect(() => {
    const eng = new MapEngine({ container: containerRef.current!, labels: labelsRef.current!, tip: tipRef.current!, compass: compassRef.current as unknown as HTMLElement });
    eng.onUserInteract = hideHint;
    eng.onFollow = (name, kmh) => { setFollow({ name, kmh }); setHint(false); };
    eng.onFollowEnd = () => setFollow(null);
    engineRef.current = eng;
    if (process.env.NODE_ENV === 'development') (window as unknown as { hometown: MapEngine }).hometown = eng; // debug handle
    const fromHash = decodeURIComponent(location.hash.slice(1));
    const q = fromHash || 'Mala, Hässleholm';
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync the input with the shared link once on mount
    if (fromHash) setPlace(fromHash);
    load(q, 1000, { hills: 2, style: 'hybrid' });
    return () => { eng.dispose(); engineRef.current = null; };
  }, [load, hideHint]);

  const toggleTraffic = () => { const on = !traffic; setTraffic(on); engineRef.current?.setTraffic(on); };

  const saveImage = () => {
    const url = engineRef.current?.screenshot();
    if (!url) return;
    const a = document.createElement('a');
    a.download = (card?.title || 'map').replace(/[^\wåäöÅÄÖ-]+/g, '-') + '.png';
    a.href = url; a.click();
  };

  return (
    <>
      <div ref={containerRef} className="map-canvas" />
      <div id="vignette" />
      <div id="labels" ref={labelsRef} />

      <section id="top" className="glass">
        <div className="brand">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><path d="M3 20 9 9l4 6 3-4 5 9z" /><circle cx="17" cy="6" r="2.2" /></svg>
          Hometown <small>any place, in 3D</small>
        </div>
        <form className="search" onSubmit={e => { e.preventDefault(); (document.activeElement as HTMLElement)?.blur(); load(place, radius, { hills, style }); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={place} onChange={e => setPlace(e.target.value)} placeholder="Search a place or lat, lon" autoComplete="off" spellCheck={false} aria-label="Place" />
          <button className="btn" type="submit" disabled={busy}>Go</button>
        </form>
        <div className="settings">
          <div className="setting wide">
            <label>Map style</label>
            <Segmented options={STYLES} value={style} onChange={v => { setStyle(v); if (!busy) rebuild(false, { hills, style: v }); }} />
          </div>
          <div className="setting">
            <label>Area</label>
            <Segmented options={RADII} value={radius} onChange={v => { setRadius(v); load(place, v, { hills, style }); }} />
          </div>
          <div className="setting">
            <label>Relief</label>
            <Segmented options={HILLS} value={hills} onChange={v => { setHills(v); if (!busy) rebuild(false, { hills: v, style }); }} />
          </div>
        </div>
      </section>

      <PlaceCard card={cardWithTrees} />
      {follow && (
        <div id="follow" className="glass" role="status">
          <span className="live" />
          <span>Following <b>{follow.name}</b></span>
          <span className="kmh">{Math.round(follow.kmh)} km/h</span>
          <button className="btn ghost" onClick={() => engineRef.current?.stopFollow()}>Stop <kbd>Esc</kbd></button>
        </div>
      )}

      <NavControls
        compassRef={compassRef}
        onNorth={() => engineRef.current?.resetNorth()}
        onZoomIn={() => engineRef.current?.zoom(0.6)}
        onZoomOut={() => engineRef.current?.zoom(1.6)}
        onHome={() => engineRef.current?.home()}
        onShot={saveImage}
        onTraffic={toggleTraffic}
        traffic={traffic}
      />

      <div id="attrib">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors
        {' · '}Elevation: Lantmäteriet / Mapzen Terrain Tiles
        {photoCredit && ' · Imagery © Esri, Maxar, Earthstar Geographics'}
      </div>

      <div id="hint" className={'glass' + (hint ? '' : ' gone')}>
        <span><b>Drag</b> or <b>arrows</b> to move</span><span><b>Right-drag</b> or <b>Shift+arrows</b> to rotate</span><span><b>Scroll</b> or <b>+/−</b> to zoom</span><span><b>Click</b> a car or train to follow it</span>
      </div>

      <Loader open={loaderOpen} steps={steps} error={error} />
      <div id="tip" className="glass" ref={tipRef} />
    </>
  );
}
