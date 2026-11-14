import type { RefObject } from 'react';

type Props = {
  compassRef: RefObject<SVGSVGElement | null>;
  onNorth: () => void; onZoomIn: () => void; onZoomOut: () => void; onHome: () => void; onShot: () => void;
  onTraffic: () => void; traffic: boolean;
};

export function NavControls({ compassRef, onNorth, onZoomIn, onZoomOut, onHome, onShot, onTraffic, traffic }: Props) {
  return (
    <div id="nav">
      <button className={'pill-btn glass' + (traffic ? ' on' : '')} onClick={onTraffic} aria-pressed={traffic} title={traffic ? 'Hide traffic' : 'Show traffic'}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 17h14v-4.5l-2-5H7l-2 5z" /><path d="M5 12.5h14" /><circle cx="8" cy="17" r="1.6" /><circle cx="16" cy="17" r="1.6" />
        </svg>
        <span>Traffic</span>
      </button>
      <button className="icon-btn glass" id="compass" title="Reset north" aria-label="Reset north" onClick={onNorth}>
        <svg ref={compassRef} width="40" height="40" viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeOpacity=".15" />
          <path d="M20 5 25 20H15z" fill="#d9483b" />
          <path d="M20 35 15 20h10z" fill="currentColor" fillOpacity=".35" />
          <text x="20" y="13.5" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="#fff">N</text>
        </svg>
      </button>
      <div className="nav-group glass">
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={onZoomIn}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={onZoomOut}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M5 12h14" /></svg>
        </button>
      </div>
      <div className="nav-group glass">
        <button className="icon-btn" title="Reset view" aria-label="Reset view" onClick={onHome}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
        </button>
        <button className="icon-btn" title="Save image" aria-label="Save image" onClick={onShot}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
        </button>
      </div>
    </div>
  );
}
