const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const enter = spring({ frame, fps, config: { damping: 20, mass: 0.6, stiffness: 140 } });

  const a = Number(p.aValue);
  const b = Number(p.bValue);
  const safeA = Number.isFinite(a) ? a : 0;
  const safeB = Number.isFinite(b) ? b : 0;
  // Bars are scaled against the larger value, so the comparison is read as a
  // ratio rather than as two numbers the viewer has to divide in their head.
  const scale = Math.max(Math.abs(safeA), Math.abs(safeB)) || 1;
  const aRatio = Math.abs(safeA) / scale;
  const bRatio = Math.abs(safeB) / scale;

  const width = item.width;
  const trackW = width - 300;

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 60px',
    boxSizing: 'border-box',
    gap: 54,
  };
  const titleStyle = {
    fontFamily: p.bodyFont,
    fontSize: 32,
    letterSpacing: '0.14em',
    color: p.muted,
    opacity: Math.min(1, enter * 1.6),
    marginBottom: 8,
  };

  const row = (label, value, ratio, color, delay) => {
    const grow = interpolate(frame, [fps * delay, fps * (delay + 0.7)], [0, 1], {
      extrapolateRight: 'clamp',
    });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 22 }}>
          <span style={{ fontFamily: p.bodyFont, fontSize: 34, color: p.muted }}>{label}</span>
          <span style={{ fontFamily: p.displayFont, fontSize: 62, color }}>{value}</span>
        </div>
        {/* Opacity on the track would dim the bar inside it too — the fill has to
            be an rgba colour so the bar keeps its own weight. */}
        <div style={{ width: trackW, height: 26, backgroundColor: 'rgba(138,133,124,0.18)', borderRadius: 13 }}>
          <div
            style={{
              // A 1000:1 comparison is honest but a 0.5px bar reads as a bug,
              // so the sliver keeps a floor that still looks like a sliver.
              width: Math.max(12, trackW * ratio * grow),
              height: '100%',
              backgroundColor: color,
              borderRadius: 13,
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div style={rootStyle}>
      {p.title ? <div style={titleStyle}>{p.title}</div> : null}
      {row(p.aLabel ?? '', safeA + (p.unit ?? ''), aRatio, p.muted === p.aColor ? p.ink : p.aColor, 0.15)}
      {row(p.bLabel ?? '', safeB + (p.unit ?? ''), bRatio, p.bColor, 0.45)}
    </div>
  );
};
