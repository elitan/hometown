export type StepKey = 'geo' | 'osm' | 'dem' | 'img' | 'build';
export type StepState = '' | 'active' | 'done' | 'fail' | 'skip';

const LABELS: [StepKey, string][] = [
  ['geo', 'Finding the place'],
  ['osm', 'Downloading roads & buildings'],
  ['dem', 'Downloading elevation'],
  ['img', 'Downloading aerial photos'],
  ['build', 'Building the scene'],
];

export function Loader({ open, steps, error }: { open: boolean; steps: Record<StepKey, StepState>; error: string }) {
  return (
    <div id="loader" className={open ? '' : 'gone'} aria-hidden={!open}>
      <div className="glass" role="status">
        <h2>Building your map…</h2>
        <ul className="steps">
          {LABELS.map(([k, label]) => (
            <li key={k} className={steps[k]}><span className="dot" />{label}</li>
          ))}
        </ul>
        {error && <div className="load-err">{error}</div>}
      </div>
    </div>
  );
}
