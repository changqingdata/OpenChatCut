const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const enter = spring({ frame, fps, config: { damping: 16, mass: 0.6, stiffness: 120 } });
  // Count over the first ~1.4s, ease-out so the number decelerates into place.
  const progress = interpolate(frame, [fps * 0.2, fps * 1.5], [0, 1], { extrapolateRight: 'clamp' });
  const eased = 1 - Math.pow(1 - progress, 3);
  const current = p.from + (p.value - p.from) * eased;
  const shown = p.decimals > 0 ? current.toFixed(p.decimals) : Math.round(current).toString();

  const labelIn = interpolate(frame, [fps * 0.45, fps * 1.0], [0, 1], { extrapolateRight: 'clamp' });
  const noteIn = interpolate(frame, [fps * 0.8, fps * 1.4], [0, 1], { extrapolateRight: 'clamp' });

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
  const labelStyle = {
    fontFamily: p.bodyFont,
    fontSize: 36,
    fontWeight: 500,
    letterSpacing: '0.22em',
    color: p.muted,
    marginBottom: 18,
    opacity: labelIn,
  };
  const rowStyle = {
    display: 'flex',
    alignItems: 'baseline',
    opacity: Math.min(1, enter * 1.7),
    transform: 'scale(' + (0.92 + 0.08 * enter) + ')',
    transformOrigin: aligned ? 'left center' : 'center center',
  };
  const prefixStyle = {
    fontFamily: p.displayFont,
    fontSize: p.fontSize * 0.42,
    color: p.accent,
    marginRight: 8,
  };
  const valueStyle = {
    fontFamily: p.displayFont,
    fontSize: p.fontSize,
    lineHeight: 0.94,
    fontWeight: 400,
    letterSpacing: '-0.04em',
    color: p.ink,
    fontVariantNumeric: 'tabular-nums',
  };
  const unitStyle = {
    fontFamily: p.displayFont,
    fontSize: p.fontSize * 0.46,
    color: p.accent,
    marginLeft: 10,
  };
  const noteStyle = {
    marginTop: 28,
    fontFamily: p.bodyFont,
    fontSize: 38,
    lineHeight: 1.45,
    color: p.muted,
    textAlign: p.align,
    opacity: noteIn,
  };

  return (
    <div style={rootStyle}>
      {p.label ? <div style={labelStyle}>{p.label}</div> : null}
      <div style={rowStyle}>
        {p.prefix ? <span style={prefixStyle}>{p.prefix}</span> : null}
        <span style={valueStyle}>{shown}</span>
        {p.unit ? <span style={unitStyle}>{p.unit}</span> : null}
      </div>
      {p.note ? <div style={noteStyle}>{p.note}</div> : null}
    </div>
  );
};
