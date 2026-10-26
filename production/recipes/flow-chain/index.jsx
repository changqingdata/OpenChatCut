const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  const steps = (Array.isArray(p.steps) ? p.steps : []).slice(0, 4);
  const labels = Array.isArray(p.labels) ? p.labels : [];
  if (steps.length < 2) return null;

  const width = item.width;
  const gap = 74;
  const boxW = (width - 120 - gap * (steps.length - 1)) / steps.length;

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 60px',
    boxSizing: 'border-box',
    gap: 40,
  };

  return (
    <div style={rootStyle}>
      {p.title ? (
        <div style={{ fontFamily: p.bodyFont, fontSize: 30, letterSpacing: '0.14em', color: p.muted }}>
          {p.title}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {steps.map((step, index) => {
          const enter = spring({
            frame: frame - Math.round(index * fps * 0.18),
            fps,
            config: { damping: 18, mass: 0.6, stiffness: 150 },
          });
          // Arrows draw left to right, so the chain reads as a sequence rather
          // than as three boxes that happen to be next to each other.
          const arrow = interpolate(
            frame,
            [fps * (0.25 + index * 0.18), fps * (0.55 + index * 0.18)],
            [0, 1],
            { extrapolateRight: 'clamp' },
          );
          return (
            <div key={index} style={{ display: 'flex', alignItems: 'center' }}>
              <div
                style={{
                  width: boxW,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 16,
                  opacity: Math.min(1, enter * 1.4),
                  transform: 'translateY(' + ((1 - enter) * 20) + 'px)',
                }}
              >
                {labels[index] ? (
                  <div style={{ fontFamily: p.bodyFont, fontSize: 24, letterSpacing: '0.2em', color: p.accent }}>
                    {labels[index]}
                  </div>
                ) : null}
                <div
                  style={{
                    fontFamily: p.displayFont,
                    fontSize: p.fontSize,
                    lineHeight: 1.25,
                    color: p.ink,
                    textAlign: 'center',
                  }}
                >
                  {step}
                </div>
              </div>
              {index < steps.length - 1 ? (
                <svg width={gap} height={40} viewBox={`0 0 ${gap} 40`} style={{ flex: '0 0 auto' }}>
                  <line
                    x1={6} y1={20} x2={6 + (gap - 22) * arrow} y2={20}
                    stroke={p.accent} strokeWidth={5} strokeLinecap="round"
                  />
                  {arrow > 0.85 ? (
                    <path
                      d={`M${gap - 22} 10 L${gap - 6} 20 L${gap - 22} 30`}
                      fill="none" stroke={p.accent} strokeWidth={5}
                      strokeLinecap="round" strokeLinejoin="round"
                    />
                  ) : null}
                </svg>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};
