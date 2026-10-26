const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // A small inline set, drawn as paths so the recipe stays one file and needs no
  // asset lookup. `icons` picks from these by name; an unknown name falls back to
  // a dot, which still reads as "an item" rather than as a hole.
  const PATHS = {
    clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v5l3.5 2',
    growth: 'M3 17l5-5 4 3 6-8M14 7h5v5',
    people: 'M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 6 2 6 5',
    coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9z',
    check: 'M4 12l5 5L20 6',
    arrow: 'M4 12h15M13 6l6 6-6 6',
    star: 'M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9-5.5 2.9 1-6.1L3 9.5l6.3-.9z',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  };

  const items = (Array.isArray(p.items) ? p.items : []).slice(0, 4);
  const icons = Array.isArray(p.icons) ? p.icons : [];
  if (!items.length) return null;

  const width = item.width;
  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    padding: '0 60px',
    boxSizing: 'border-box',
    gap: 46,
  };
  const rowStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' };

  return (
    <div style={rootStyle}>
      {p.title ? (
        <div style={{ fontFamily: p.bodyFont, fontSize: 32, letterSpacing: '0.14em', color: p.muted }}>
          {p.title}
        </div>
      ) : null}
      <div style={rowStyle}>
        {items.map((label, index) => {
          const enter = spring({
            frame: frame - Math.round(index * fps * 0.14),
            fps,
            config: { damping: 18, mass: 0.6, stiffness: 150 },
          });
          const path = PATHS[icons[index]] ?? null;
          return (
            <div
              key={index}
              style={{
                width: (width - 120) / items.length - 18,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 22,
                opacity: Math.min(1, enter * 1.4),
                transform: 'translateY(' + ((1 - enter) * 26) + 'px)',
              }}
            >
              <svg width={92} height={92} viewBox="0 0 24 24" fill="none"
                stroke={p.accent} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                {path
                  ? <path d={path} />
                  : <circle cx="12" cy="12" r="6" fill={p.accent} stroke="none" />}
              </svg>
              <div
                style={{
                  fontFamily: p.displayFont,
                  fontSize: p.fontSize,
                  color: p.ink,
                  textAlign: 'center',
                  lineHeight: 1.25,
                }}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
