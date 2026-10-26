const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const topIn = interpolate(frame, [0, fps * 0.45], [0, 1], { extrapolateRight: 'clamp' });
  const divider = interpolate(frame, [fps * 0.35, fps * 0.85], [0, 1], { extrapolateRight: 'clamp' });
  const bottomIn = interpolate(frame, [fps * 0.7, fps * 1.2], [0, 1], { extrapolateRight: 'clamp' });

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 20px',
    boxSizing: 'border-box',
  };
  const blockStyle = { display: 'flex', flexDirection: 'column' };
  const topBlockStyle = {
    ...blockStyle,
    opacity: topIn,
    transform: 'translateY(' + ((1 - topIn) * -20) + 'px)',
  };
  const bottomBlockStyle = {
    ...blockStyle,
    opacity: bottomIn,
    transform: 'translateY(' + ((1 - bottomIn) * 24) + 'px)',
  };
  const labelStyle = (color) => ({
    fontFamily: p.bodyFont,
    fontSize: 32,
    fontWeight: 500,
    letterSpacing: '0.28em',
    color: color,
    marginBottom: 16,
  });
  const textStyle = (color) => ({
    fontFamily: p.displayFont,
    fontSize: p.fontSize,
    lineHeight: 1.28,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: color,
    whiteSpace: 'pre-wrap',
  });
  const dividerStyle = {
    height: 3,
    width: (p.dividerWidth * divider) + 'px',
    backgroundColor: p.muted,
    opacity: 0.45,
    margin: p.gap + 'px 0',
  };

  return (
    <div style={rootStyle}>
      <div style={topBlockStyle}>
        <div style={labelStyle(p.muted)}>{p.topLabel}</div>
        {/* Empty topColor means "derive from muted": that way the compiler's
             over-footage correction reaches the dimmed line too. */}
        <div style={textStyle(p.topColor || p.muted)}>{p.topText}</div>
      </div>
      <div style={dividerStyle} />
      <div style={bottomBlockStyle}>
        <div style={labelStyle(p.accent)}>{p.bottomLabel}</div>
        <div style={textStyle(p.bottomColor)}>{p.bottomText}</div>
      </div>
    </div>
  );
};
