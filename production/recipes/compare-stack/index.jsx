const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;
  // The compiler swaps the design box when the canvas is wide, and says so.
  // Same content, different arrangement: stacked top/bottom reads as a before
  // and after on a phone, but on 16:9 it is a narrow column with the right half
  // of the frame empty. Side by side is the landscape form of the same idea.
  const wide = p.landscape === true;

  const topIn = interpolate(frame, [0, fps * 0.45], [0, 1], { extrapolateRight: 'clamp' });
  const divider = interpolate(frame, [fps * 0.35, fps * 0.85], [0, 1], { extrapolateRight: 'clamp' });
  const bottomIn = interpolate(frame, [fps * 0.7, fps * 1.2], [0, 1], { extrapolateRight: 'clamp' });

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: wide ? 'row' : 'column',
    justifyContent: 'center',
    alignItems: wide ? 'center' : 'stretch',
    padding: wide ? '0 40px' : '0 20px',
    boxSizing: 'border-box',
  };
  const blockStyle = {
    display: 'flex',
    flexDirection: 'column',
    ...(wide ? { flex: '1 1 0', minWidth: 0 } : {}),
  };
  // In a row, the two blocks slide in from opposite sides; the vertical
  // translate that suits a stack reads as a wobble.
  const topBlockStyle = {
    ...blockStyle,
    opacity: topIn,
    transform: wide
      ? 'translateX(' + ((1 - topIn) * -30) + 'px)'
      : 'translateY(' + ((1 - topIn) * -20) + 'px)',
  };
  const bottomBlockStyle = {
    ...blockStyle,
    opacity: bottomIn,
    transform: wide
      ? 'translateX(' + ((1 - bottomIn) * 30) + 'px)'
      : 'translateY(' + ((1 - bottomIn) * 24) + 'px)',
  };
  const labelStyle = (color) => ({
    fontFamily: p.bodyFont,
    fontSize: wide ? 38 : 32,
    fontWeight: 500,
    letterSpacing: '0.28em',
    color: color,
    marginBottom: wide ? 20 : 16,
  });
  // A fixed size has to fit the longest line it might ever get, so short lines
  // come out timid. Fit to the actual text instead, capped so a three-character
  // line does not turn into a poster.
  const gutter = wide ? p.gap * 2 + 3 : 120;
  const fitSize = (text) => {
    const chars = Array.from(String(text ?? '')).length || 1;
    const inner = (item.width - gutter) / (wide ? 2 : 1);
    return Math.min(Math.round(p.fontSize * 1.7), Math.floor((inner / chars) * 0.92));
  };
  const bodySize = Math.min(fitSize(p.topText), fitSize(p.bottomText));

  const textStyle = (color) => ({
    fontFamily: p.displayFont,
    fontSize: bodySize,
    lineHeight: 1.28,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    color: color,
    whiteSpace: 'pre-wrap',
  });
  // A short horizontal rule is the stacked form of "these two are the same
  // kind of thing"; the row form is a vertical one between the columns.
  const dividerStyle = wide
    ? {
      width: 3,
      alignSelf: 'stretch',
      margin: '6% ' + p.gap + 'px',
      backgroundColor: p.muted,
      opacity: 0.45 * divider,
    }
    : {
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
