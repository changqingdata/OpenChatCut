const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // The punch: a low-damping spring so the word overshoots slightly and settles.
  const enter = spring({ frame, fps, config: { damping: 13, mass: 0.55, stiffness: 130 } });
  const bar = interpolate(frame, [fps * 0.1, fps * 0.6], [0, 1], { extrapolateRight: 'clamp' });
  const label = interpolate(frame, [fps * 0.3, fps * 0.85], [0, 1], { extrapolateRight: 'clamp' });
  const tail = interpolate(frame, [fps * 0.5, fps * 1.1], [0, 1], { extrapolateRight: 'clamp' });

  const aligned = p.align === 'left';
  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: aligned ? 'flex-start' : 'center',
    padding: '0 20px',
    boxSizing: 'border-box',
  };
  const barStyle = {
    width: 104 * bar,
    height: 9,
    borderRadius: 5,
    backgroundColor: p.accent,
    marginBottom: 26,
  };
  const labelStyle = {
    fontFamily: p.bodyFont,
    fontSize: 34,
    fontWeight: 500,
    letterSpacing: '0.3em',
    color: p.muted,
    marginBottom: 18,
    opacity: label,
  };
  const wordStyle = {
    fontFamily: p.displayFont,
    fontSize: p.fontSize,
    lineHeight: 1.04,
    fontWeight: 400,
    letterSpacing: '-0.03em',
    color: p.ink,
    textAlign: p.align,
    whiteSpace: 'pre-wrap',
    transform: 'scale(' + (0.84 + 0.16 * enter) + ')',
    transformOrigin: aligned ? 'left center' : 'center center',
    opacity: Math.min(1, enter * 1.8),
  };
  const accentWordStyle = { color: p.accent };
  const tailStyle = {
    marginTop: 26,
    fontFamily: p.bodyFont,
    fontSize: 38,
    lineHeight: 1.45,
    color: p.muted,
    textAlign: p.align,
    opacity: tail,
  };

  return (
    <div style={rootStyle}>
      <div style={barStyle} />
      {p.label ? <div style={labelStyle}>{p.label}</div> : null}
      <div style={wordStyle}>
        {p.text}
        {p.accentText ? <span style={accentWordStyle}>{p.accentText}</span> : null}
      </div>
      {p.tail ? <div style={tailStyle}>{p.tail}</div> : null}
    </div>
  );
};
