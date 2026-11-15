export type Chip = { color: string; text: string; pulse?: boolean };

export function PlaceCard({ card }: { card: { title: string; subtitle: string; chips: Chip[] } | null }) {
  return (
    <section id="card" className={'glass' + (card ? '' : ' hidden')}>
      <div className="eyebrow">Now viewing</div>
      <h1>{card?.title ?? '—'}</h1>
      <div className="sub">{card?.subtitle}</div>
      <div className="chips">
        {card?.chips.map(c => (
          <span key={c.text} className={'chip' + (c.pulse ? ' pulse' : '')}><i style={{ background: c.color }} />{c.text}</span>
        ))}
      </div>
    </section>
  );
}
