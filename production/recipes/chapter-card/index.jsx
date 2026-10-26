const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const enter = spring({ frame, fps, config: { damping: 22, mass: 0.7, stiffness: 130 } });
  const rule = interpolate(frame, [fps * 0.25, fps * 0.85], [0, 1], { extrapolateRight: 'clamp' });

  const width = item.width;
  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 96px',
    boxSizing: 'border-box',
  };

  return (
    <div style={rootStyle}>
      <div style={{ fontFamily: p.bodyFont, fontSize: 30, letterSpacing: '0.32em', color: p.accent,
        opacity: Math.min(1, enter * 1.5) }}>
        {p.kicker || 'CHAPTER'}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 26, marginTop: 26,
        opacity: Math.min(1, enter * 1.2), transform: 'translateY(' + ((1 - enter) * 24) + 'px)' }}>
        <span style={{ fontFamily: p.displayFont, fontSize: p.numberSize, lineHeight: 0.9, color: p.accent }}>
          {p.number}
        </span>
        <span style={{ fontFamily: p.displayFont, fontSize: p.titleSize, lineHeight: 1.15, color: p.ink }}>
          {p.title}
        </span>
      </div>
      <div style={{ height: 4, width: width * 0.28 * rule, backgroundColor: p.accent, borderRadius: 2, marginTop: 34 }} />
      {p.subtitle ? (
        <div style={{ fontFamily: p.bodyFont, fontSize: 34, color: p.muted, marginTop: 28,
          opacity: interpolate(frame, [fps * 0.5, fps * 1.0], [0, 1], { extrapolateRight: 'clamp' }) }}>
          {p.subtitle}
        </div>
      ) : null}
    </div>
  );
};
