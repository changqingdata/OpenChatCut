const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = item.props;

  // A slam: it arrives oversized and settles, rather than growing into place.
  const enter = spring({ frame, fps, config: { damping: 18, mass: 0.7, stiffness: 150 } });
  const scale = 1.24 - 0.24 * enter;
  const opacity = Math.min(1, enter * 2.2);
  const glow = interpolate(frame, [0, fps * 0.8], [0.22, 0], { extrapolateRight: 'clamp' });

  // Two characters at 620px each is 1240px in a 1080px box: the outer strokes
  // get cropped. Size is capped by the box so any character count fits.
  const glyphs = Array.from(String(p.text ?? ''));
  const perGlyph = glyphs.length > 0 ? (item.width / glyphs.length) * 0.9 : p.fontSize;
  const size = Math.min(p.fontSize, perGlyph);

  const rootStyle = {
    position: 'absolute',
    inset: 0,
    backgroundColor: p.bg || 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  const wordStyle = {
    fontFamily: p.displayFont,
    fontSize: size,
    // 0.86 collided: a 760px em box in a 654px line box overlapped the line above.
    lineHeight: 1.0,
    fontWeight: 400,
    letterSpacing: p.tracking,
    color: p.ink,
    textAlign: 'center',
    transform: 'scale(' + scale + ')',
    opacity: opacity,
    textShadow: '0 0 ' + (60 * glow) + 'px ' + p.accent,
  };
  const captionStyle = {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: p.captionOffset,
    textAlign: 'center',
    fontFamily: p.bodyFont,
    fontSize: 34,
    letterSpacing: '0.3em',
    color: p.muted,
    opacity: interpolate(frame, [fps * 0.4, fps * 1.0], [0, 1], { extrapolateRight: 'clamp' }),
  };

  return (
    <div style={rootStyle}>
      <div style={wordStyle}>{p.text}</div>
      {p.caption ? <div style={captionStyle}>{p.caption}</div> : null}
    </div>
  );
};
