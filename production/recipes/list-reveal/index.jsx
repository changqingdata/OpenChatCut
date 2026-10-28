const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;
  // Wide canvas: the same items become columns. A numbered column reads
  // left-to-right the way the list reads top-to-bottom, and it fills a 16:9
  // frame instead of leaving two thirds of it black.
  const wide = p.landscape === true;

  const items = Array.isArray(p.items) ? p.items : [];
  const titleIn = interpolate(frame, [0, fps * 0.45], [0, 1], { extrapolateRight: 'clamp' });
  const stagger = fps * 0.3;
  const rowDur = fps * 0.55;

  const aligned = p.align === 'left';
  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: wide ? 'center' : aligned ? 'flex-start' : 'stretch',
    padding: wide ? '0 40px' : '0 20px',
    boxSizing: 'border-box',
  };
  const titleStyle = {
    fontFamily: p.bodyFont,
    fontSize: wide ? 40 : 34,
    fontWeight: 500,
    letterSpacing: '0.24em',
    color: p.muted,
    marginBottom: wide ? 46 : 34,
    opacity: titleIn,
  };
  const listStyle = {
    display: 'flex',
    flexDirection: wide ? 'row' : 'column',
    gap: wide ? p.gap * 2 : p.gap,
    width: wide ? '100%' : undefined,
  };

  return (
    <div style={rootStyle}>
      {p.title ? <div style={titleStyle}>{p.title}</div> : null}
      <div style={listStyle}>
        {items.map((text, index) => {
          const local = frame - fps * 0.25 - index * stagger;
          const t = interpolate(local, [0, rowDur], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const rowStyle = wide
            ? {
              display: 'flex',
              flexDirection: 'column',
              flex: '1 1 0',
              minWidth: 0,
              alignItems: 'center',
              textAlign: 'center',
              opacity: t,
              transform: 'translateY(' + ((1 - t) * 28) + 'px)',
            }
            : {
              display: 'flex',
              alignItems: 'flex-start',
              opacity: t,
              transform: 'translateX(' + ((1 - t) * -34) + 'px)',
            };
          const markStyle = {
            flexShrink: 0,
            width: wide ? undefined : p.markWidth,
            fontFamily: p.displayFont,
            fontSize: wide ? 40 : 46,
            lineHeight: 1.35,
            color: p.accent,
          };
          const textStyle = {
            fontFamily: p.displayFont,
            fontSize: p.fontSize,
            lineHeight: 1.32,
            fontWeight: 400,
            letterSpacing: '-0.01em',
            color: p.ink,
          };
          return (
            <div key={index} style={rowStyle}>
              <div style={markStyle}>{String(index + 1).padStart(2, '0')}</div>
              <div style={textStyle}>{text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
