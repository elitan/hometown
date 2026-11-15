import { useEffect, useRef } from 'react';
import { clock, type Season } from '../lib/map/sun';
import { Segmented } from './Segmented';

const SEASON_OPTIONS: { v: Season; label: string }[] = [
  { v: 'spring', label: 'Spring' }, { v: 'summer', label: 'Summer' }, { v: 'autumn', label: 'Autumn' }, { v: 'winter', label: 'Winter' },
];
const DAY_SECONDS = 60; // a played day takes a minute

/** Season buttons and a clock slider with play (a day in a minute) and a "Now" button. */
export function TimeControls({ season, hour, playing, onSeason, onHour, onPlay, onNow }: {
  season: Season; hour: number; playing: boolean;
  onSeason: (s: Season) => void; onHour: (h: number) => void; onPlay: (on: boolean) => void; onNow: () => void;
}) {
  // advance the clock while playing
  const hourRef = useRef(hour);
  hourRef.current = hour;
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const step = (t: number) => {
      onHour((hourRef.current + ((t - last) / 1000) * (24 / DAY_SECONDS)) % 24);
      last = t;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, onHour]);

  return (
    <>
      <div className="setting wide">
        <label>Season</label>
        <Segmented options={SEASON_OPTIONS} value={season} onChange={onSeason} />
      </div>
      <div className="setting wide">
        <label>Time of day</label>
        <div className="clock">
          <button type="button" className="clock-play" onClick={() => onPlay(!playing)} aria-label={playing ? 'Pause' : 'Play the day'} title={playing ? 'Pause' : 'Play the day'}>
            {playing
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 4.5v15l12-7.5z" /></svg>}
          </button>
          <input type="range" min={0} max={24} step={0.25} value={hour} onChange={e => { onPlay(false); onHour(Number(e.target.value)); }} aria-label="Time of day" />
          <span className="clock-time">{clock(hour)}</span>
          <button type="button" className="clock-now" onClick={onNow}>Now</button>
        </div>
      </div>
    </>
  );
}
