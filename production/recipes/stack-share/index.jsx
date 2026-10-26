const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const parts = (Array.isArray(p.parts) ? p.parts : []).slice(0, 4);
  const values = (Array.isArray(p.values) ? p.values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(0, parts.length);
  if (parts.length < 2 || values.length !== parts.length) return null;

  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const shares = values.map((value) => value / total);

  // Each segment grows into place in turn, so the bar reads as parts adding up
  // rather than as a finished chart that faded in.
  const grow = (index) => interpolate(
    frame,
    [fps * (0.15 + index * 0.14), fps * (0.6 + index * 0.14)],
    [0, 1],
    { extrapolateRight: 'clamp' },
  );

  const width = item.width;
  const trackW = width - 120;
  // One accent, one ink, and muted greys for the rest: four saturated colours
  // would fight each other and none of them would read as "the important one".
  // The fourth colour has to survive on a near-black card: a dark grey at low
  // alpha disappears into the background and the segment looks like a gap.
  const fills = [p.accent, p.ink, p.muted, 'rgba(242,239,233,0.32)'];

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 60px',
    boxSizing: 'border-box',
    gap: 50,
  };

  return (
    <div style={rootStyle}>
      {p.title ? (
        <div style={{ fontFamily: p.bodyFont, fontSize: 30, letterSpacing: '0.14em', color: p.muted }}>
          {p.title}
        </div>
      ) : null}
      <div style={{ display: 'flex', width: trackW, height: 76, borderRadius: 10, overflow: 'hidden' }}>
        {shares.map((share, index) => (
          <div
            key={index}
            style={{
              width: trackW * share * grow(index),
              height: '100%',
              backgroundColor: fills[index % fills.length],
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', width: trackW, gap: 28, flexWrap: 'wrap' }}>
        {parts.map((part, index) => (
          <div
            key={index}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              opacity: grow(index),
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                backgroundColor: fills[index % fills.length],
                flex: '0 0 auto',
              }}
            />
            <span style={{ fontFamily: p.bodyFont, fontSize: 34, color: p.muted }}>{part}</span>
            <span style={{ fontFamily: p.displayFont, fontSize: 38, color: p.ink }}>
              {values[index] + (p.unit ?? '')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
