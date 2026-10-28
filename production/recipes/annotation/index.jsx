const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // The ring draws itself, then the label follows. A ring that simply appears
  // reads as a sticker; one that draws reads as someone pointing.
  const draw = interpolate(frame, [fps * 0.15, fps * 0.7], [0, 1], { extrapolateRight: 'clamp' });
  const labelIn = interpolate(frame, [fps * 0.6, fps * 0.95], [0, 1], { extrapolateRight: 'clamp' });

  const width = item.width;
  const height = item.height;
  // `Number(undefined)` is NaN, not nullish, so `?? 0.5` would never fire and the
  // ring would land at NaN — invisible. Check for a finite number instead.
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const clamp01 = (value) => Math.min(1, Math.max(0, value));

  // Short side, not width: a ring sized from the width covers 71% of a 16:9
  // frame's height at the same fraction, which is never what "circle this" means.
  const size = Math.min(width, height) * Math.min(1, Math.max(0.12, num(p.size, 0.4)));
  const cx = width * clamp01(num(p.x, 0.5));
  const cy = height * clamp01(num(p.y, 0.5));
  const stroke = p.strokeWidth ?? 6;

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
  };

  // A rounded box traces its outline; a circle uses the dash trick so both
  // shapes reveal in the same gesture.
  const circumference = 2 * Math.PI * (size / 2);
  const boxLength = size * 4;

  return (
    <div style={rootStyle}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        {p.shape === 'box' ? (
          <rect
            x={cx - size / 2} y={cy - size / 2} width={size} height={size}
            rx={size * 0.08}
            fill="none" stroke={p.accent} strokeWidth={stroke}
            strokeDasharray={boxLength} strokeDashoffset={boxLength * (1 - draw)}
          />
        ) : (
          <circle
            cx={cx} cy={cy} r={size / 2}
            fill="none" stroke={p.accent} strokeWidth={stroke}
            strokeDasharray={circumference} strokeDashoffset={circumference * (1 - draw)}
          />
        )}
      </svg>
      {p.label ? (
        <div
          style={{
            position: 'absolute',
            left: cx,
            top: cy + size / 2 + 26,
            transform: 'translateX(-50%)',
            opacity: labelIn,
            fontFamily: p.bodyFont,
            fontSize: p.fontSize,
            color: p.ink,
            whiteSpace: 'nowrap',
            // A dark pill keeps the label readable over whatever it is pointing at.
            backgroundColor: 'rgba(11,11,12,0.72)',
            padding: '10px 22px',
            borderRadius: 8,
          }}
        >
          {p.label}
        </div>
      ) : null}
    </div>
  );
};
