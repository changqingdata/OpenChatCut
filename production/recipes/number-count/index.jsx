const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;
  // Wide canvas: the number moves left and the words sit beside it. Centred,
  // a number card is a narrow column — correct on a phone, and on 16:9 it reads
  // as a slide someone forgot to lay out.
  const wide = p.landscape === true;

  const enter = spring({ frame, fps, config: { damping: 16, mass: 0.6, stiffness: 120 } });
  // Count over the first ~1.4s, ease-out so the number decelerates into place.
  const progress = interpolate(frame, [fps * 0.2, fps * 1.5], [0, 1], { extrapolateRight: 'clamp' });
  const eased = 1 - Math.pow(1 - progress, 3);
  const current = p.from + (p.value - p.from) * eased;
  const shown = p.decimals > 0 ? current.toFixed(p.decimals) : Math.round(current).toString();

  const labelIn = interpolate(frame, [fps * 0.45, fps * 1.0], [0, 1], { extrapolateRight: 'clamp' });
  const noteIn = interpolate(frame, [fps * 0.8, fps * 1.4], [0, 1], { extrapolateRight: 'clamp' });

  const aligned = p.align === 'left';
  const numSize = wide ? Math.round(p.fontSize * 1.12) : p.fontSize;
  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: wide ? 'row' : 'column',
    justifyContent: 'center',
    alignItems: wide ? 'center' : aligned ? 'flex-start' : 'center',
    gap: wide ? 64 : 0,
    padding: wide ? '0 60px' : '0 20px',
    boxSizing: 'border-box',
  };
  const labelStyle = {
    fontFamily: p.bodyFont,
    fontSize: wide ? 42 : 36,
    fontWeight: 500,
    letterSpacing: '0.22em',
    color: p.muted,
    marginBottom: 18,
    opacity: labelIn,
  };
  const rowStyle = {
    display: 'flex',
    alignItems: 'baseline',
    flexShrink: 0,
    opacity: Math.min(1, enter * 1.7),
    transform: 'scale(' + (0.92 + 0.08 * enter) + ')',
    transformOrigin: wide || aligned ? 'left center' : 'center center',
  };
  const prefixStyle = {
    fontFamily: p.displayFont,
    fontSize: numSize * 0.42,
    color: p.accent,
    marginRight: 8,
  };
  const valueStyle = {
    fontFamily: p.displayFont,
    fontSize: numSize,
    lineHeight: 0.94,
    fontWeight: 400,
    letterSpacing: '-0.04em',
    color: p.ink,
    fontVariantNumeric: 'tabular-nums',
  };
  const unitStyle = {
    fontFamily: p.displayFont,
    fontSize: numSize * 0.46,
    color: p.accent,
    marginLeft: 10,
  };
  const noteStyle = {
    marginTop: 28,
    fontFamily: p.bodyFont,
    fontSize: wide ? 42 : 38,
    lineHeight: 1.45,
    color: p.muted,
    textAlign: p.align,
    opacity: noteIn,
  };

  const numberRow = (
    <div style={rowStyle}>
      {p.prefix ? <span style={prefixStyle}>{p.prefix}</span> : null}
      <span style={valueStyle}>{shown}</span>
      {p.unit ? <span style={unitStyle}>{p.unit}</span> : null}
    </div>
  );

  if (wide) {
    return (
      <div style={rootStyle}>
        {numberRow}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
          {p.label ? <div style={labelStyle}>{p.label}</div> : null}
          {p.note ? <div style={{ ...noteStyle, marginTop: 0, textAlign: 'left' }}>{p.note}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div style={rootStyle}>
      {p.label ? <div style={labelStyle}>{p.label}</div> : null}
      {numberRow}
      {p.note ? <div style={noteStyle}>{p.note}</div> : null}
    </div>
  );
};
