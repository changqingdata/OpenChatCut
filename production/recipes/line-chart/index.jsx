const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // The line draws itself: the path is revealed by animating the dash offset,
  // which keeps the motion tied to the data rather than to a generic fade.
  const draw = interpolate(frame, [fps * 0.15, fps * 1.15], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const dotIn = (index) => interpolate(frame, [fps * (0.5 + index * 0.08), fps * (0.75 + index * 0.08)], [0, 1], {
    extrapolateRight: 'clamp',
  });

  const points = (Array.isArray(p.points) ? p.points : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const labels = Array.isArray(p.labels) ? p.labels : [];
  if (points.length < 2) return null;

  const width = item.width;
  const height = item.height;
  const padX = 70;
  const padTop = p.title ? 130 : 60;
  const padBottom = 90;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;

  const coords = points.map((value, index) => ({
    x: padX + (plotW * index) / (points.length - 1),
    // A flat series would sit on the baseline; give it breathing room.
    y: padTop + plotH - ((value - min) / span) * plotH,
    value,
  }));

  const path = coords
    .map((point, index) => (index === 0 ? 'M' : 'L') + point.x.toFixed(1) + ' ' + point.y.toFixed(1))
    .join(' ');

  // The reveal length has to match the real path, or the line appears to finish
  // early or late depending on how far the data travels.
  let length = 0;
  for (let i = 1; i < coords.length; i += 1) {
    length += Math.hypot(coords[i].x - coords[i - 1].x, coords[i].y - coords[i - 1].y);
  }

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    padding: '0 0 0 0',
    boxSizing: 'border-box',
  };
  const titleStyle = {
    position: 'absolute',
    left: padX,
    top: 54,
    fontFamily: p.bodyFont,
    fontSize: 34,
    letterSpacing: '0.14em',
    color: p.muted,
    opacity: interpolate(frame, [0, fps * 0.4], [0, 1], { extrapolateRight: 'clamp' }),
  };

  return (
    <div style={rootStyle}>
      {p.title ? <div style={titleStyle}>{p.title}</div> : null}
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        <line
          x1={padX} y1={padTop + plotH} x2={width - padX} y2={padTop + plotH}
          stroke={p.muted} strokeWidth={2} opacity={0.35}
        />
        <path
          d={path}
          fill="none"
          stroke={p.accent}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - draw)}
        />
        {coords.map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={index === coords.length - 1 ? 13 : 8}
            fill={index === coords.length - 1 ? p.accent : p.ink}
            opacity={dotIn(index)}
          />
        ))}
      </svg>
      {coords.map((point, index) => (
        <div
          key={'label' + index}
          style={{
            position: 'absolute',
            left: point.x,
            top: padTop + plotH + 22,
            transform: 'translateX(-50%)',
            fontFamily: p.bodyFont,
            fontSize: 26,
            color: p.muted,
            opacity: dotIn(index),
            whiteSpace: 'nowrap',
          }}
        >
          {labels[index] ?? ''}
        </div>
      ))}
      <div
        style={{
          position: 'absolute',
          // Keep the end value inside the canvas: the last point sits at the right
          // edge, so a centred label would hang off it.
          left: Math.min(coords[coords.length - 1].x, width - 110),
          top: coords[coords.length - 1].y - 78,
          transform: 'translateX(-50%)',
          fontFamily: p.displayFont,
          fontSize: 64,
          color: p.ink,
          opacity: dotIn(coords.length - 1),
          whiteSpace: 'nowrap',
        }}
      >
        {p.unit === '%' ? points[points.length - 1] + '%' : (p.unit || '') + points[points.length - 1]}
      </div>
    </div>
  );
};
