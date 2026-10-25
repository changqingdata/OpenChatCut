const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const items = Array.isArray(p.items) ? p.items : [];
  const line = interpolate(frame, [fps * 0.1, fps * 0.9], [0, 1], { extrapolateRight: 'clamp' });
  const stagger = fps * 0.24;

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
  const titleStyle = {
    fontFamily: p.bodyFont,
    fontSize: 32,
    fontWeight: 500,
    letterSpacing: '0.22em',
    color: p.muted,
    marginBottom: 46,
    opacity: interpolate(frame, [0, fps * 0.4], [0, 1], { extrapolateRight: 'clamp' }),
  };
  const trackStyle = {
    position: 'relative',
    height: 3,
    backgroundColor: p.trackColor,
    marginBottom: 40,
  };
  const lineStyle = {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: (line * 100) + '%',
    backgroundColor: p.accent,
  };
  const rowStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  };

  return (
    <div style={rootStyle}>
      {p.title ? <div style={titleStyle}>{p.title}</div> : null}
      <div style={trackStyle}>
        <div style={lineStyle} />
      </div>
      <div style={rowStyle}>
        {items.map((label, index) => {
          const local = frame - fps * 0.5 - index * stagger;
          const t = interpolate(local, [0, fps * 0.45], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const isActive = index === p.activeIndex;
          const dotStyle = {
            width: isActive ? 20 : 12,
            height: isActive ? 20 : 12,
            borderRadius: 10,
            backgroundColor: isActive ? p.accent : p.muted,
            marginBottom: 18,
            opacity: t,
          };
          // `flex: 1` plus nowrap: a percentage maxWidth made Chinese wrap one
          // character per line, which stacked the labels vertically.
          const textStyle = {
            fontFamily: p.displayFont,
            fontSize: p.fontSize,
            lineHeight: 1.3,
            color: isActive ? p.ink : p.muted,
            opacity: t,
            whiteSpace: 'nowrap',
          };
          const cellStyle = {
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            minWidth: 0,
          };
          return (
            <div key={index} style={cellStyle}>
              <div style={dotStyle} />
              <div style={textStyle}>{label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
