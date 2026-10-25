const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

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
    alignItems: aligned ? 'flex-start' : 'stretch',
    padding: '0 20px',
    boxSizing: 'border-box',
  };
  const titleStyle = {
    fontFamily: p.bodyFont,
    fontSize: 34,
    fontWeight: 500,
    letterSpacing: '0.24em',
    color: p.muted,
    marginBottom: 34,
    opacity: titleIn,
  };
  const listStyle = { display: 'flex', flexDirection: 'column', gap: p.gap };

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
          const rowStyle = {
            display: 'flex',
            alignItems: 'flex-start',
            opacity: t,
            transform: 'translateX(' + ((1 - t) * -34) + 'px)',
          };
          const markStyle = {
            flexShrink: 0,
            width: p.markWidth,
            fontFamily: p.displayFont,
            fontSize: 46,
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
