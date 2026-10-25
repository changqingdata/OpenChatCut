const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // The bar fills over ~1.2s and the number counts with it, so the length and
  // the figure agree at every moment — a bar that finishes early reads as wrong.
  const enter = interpolate(frame, [0, fps * 0.4], [0, 1], { extrapolateRight: 'clamp' });
  const progress = interpolate(frame, [fps * 0.25, fps * 1.45], [0, 1], { extrapolateRight: 'clamp' });
  const eased = 1 - Math.pow(1 - progress, 3);
  const shown = eased * p.value;
  const digits = p.decimals > 0 ? shown.toFixed(p.decimals) : Math.round(shown).toString();

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 20px',
    boxSizing: 'border-box',
    opacity: enter,
  };
  const headStyle = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 22,
  };
  const labelStyle = {
    fontFamily: p.bodyFont,
    fontSize: 34,
    fontWeight: 500,
    letterSpacing: '0.1em',
    color: p.muted,
  };
  const valueStyle = {
    fontFamily: p.displayFont,
    fontSize: 74,
    lineHeight: 1,
    color: p.ink,
    fontVariantNumeric: 'tabular-nums',
  };
  const unitStyle = { fontSize: 40, color: p.accent, marginLeft: 4 };
  const trackStyle = {
    position: 'relative',
    height: p.thickness,
    borderRadius: p.thickness / 2,
    backgroundColor: p.trackColor,
    overflow: 'hidden',
  };
  const fillStyle = {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: (eased * 100) + '%',
    borderRadius: p.thickness / 2,
    backgroundColor: p.accent,
  };
  const noteStyle = {
    marginTop: 22,
    fontFamily: p.bodyFont,
    fontSize: 30,
    color: p.muted,
  };

  return (
    <div style={rootStyle}>
      <div style={headStyle}>
        <div style={labelStyle}>{p.label}</div>
        <div style={valueStyle}>
          {digits}
          <span style={unitStyle}>{p.unit}</span>
        </div>
      </div>
      <div style={trackStyle}>
        <div style={fillStyle} />
      </div>
      {p.note ? <div style={noteStyle}>{p.note}</div> : null}
    </div>
  );
};
